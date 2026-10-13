"""KOOK Palworld assistant. All inventory calls pass through the claim ledger."""
import asyncio
import json
import logging
import os
from pathlib import Path
import re
import signal
import sys
import threading
import time
import uuid

from bridge import EventBridge
from catalog import Catalog, FOOD_TOPIC, food_intent, quantity_followup
from policy import evaluate_request, available_basic_foods
from delivery import DeliveryCoordinator
from model import Model
from runtime import Runtime, event_text
from store import Store, BindingConflict
from transport import GameClient

LOG = logging.getLogger('palworld-bot')
HELP = '''可直接说：申请木头 30 个、申请石头 20 个、申请食物 5 份。
第一次使用：发送「绑定 游戏角色名」，再到游戏聊天框输入验证码命令。
「状态」查看世界进度；「我的次数」查看今日配额；「帮助」查看说明。
每位绑定玩家每天最多 3 次，北京时间 00:00 重置。拒绝和明确未发放不扣次数；结果不明时保留次数待核对。
成品装备按核实的配方发材料；食物、药品可直接申请。
不知道吃什么可说「有什么食物」；「申请食物 10 份」会按实际进度挑选普通食品。'''


class Bot:
    def __init__(self, env=os.environ):
        self.state = Path(env.get('STATE_DIR', './data'))
        self.state.mkdir(parents=True, exist_ok=True)
        self.store = Store(self.state / 'claims.sqlite')
        self.runtime = Runtime(self.state / 'runtime.sqlite')
        self.bridge = EventBridge(self.state / 'events.sqlite', game_base=env.get('PALWORLD_GAME_BASE', '/opt/palworld'))
        self.catalog = Catalog.from_file(env['PALWORLD_CATALOG'])
        self.game = GameClient(env['PALWORLD_API_URL'], env['PALWORLD_API_TOKEN'])
        self.delivery = DeliveryCoordinator(self.store, self.game)
        self.model = Model(env['OPENAI_BASE_URL'].rstrip('/'), env['OPENAI_API_KEY'], env.get('OPENAI_MODEL', 'gpt-6-astra'))
        self.replies = {}
        self._input_queue = asyncio.Queue()
        self._input_thread_started = False
        self.wakeup = asyncio.Event()
        self.stopping = asyncio.Event()
        self.health = {'started_at': time.time(), 'last_game_poll': None, 'last_error': None}

    def emit(self, value):
        print(json.dumps(value, ensure_ascii=False), flush=True)

    async def send(self, text, quote=None, theme='info'):
        request_id = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self.replies[request_id] = future
        self.emit({'op': 'send', 'id': request_id, 'text': text, 'quote': quote, 'theme': theme})
        try:
            return await asyncio.wait_for(future, timeout=30)
        finally:
            self.replies.pop(request_id, None)

    async def input_loop(self):
        if not self._input_thread_started:
            self._input_thread_started = True
            loop = asyncio.get_running_loop()
            def read_stdin():
                # A daemon reader cannot keep systemd from restarting this
                # process if the Node gateway or another worker fails.
                while True:
                    line = sys.stdin.readline()
                    if not line:
                        loop.call_soon_threadsafe(self._input_queue.put_nowait, None)
                        return
                    loop.call_soon_threadsafe(self._input_queue.put_nowait, line)
            threading.Thread(target=read_stdin, name='stdin-reader', daemon=True).start()
        while not self.stopping.is_set():
            line = await self._input_queue.get()
            if not line:
                self.stopping.set()
                return
            try:
                value = json.loads(line)
                if value['op'] == 'result':
                    future = self.replies.get(value['id'])
                    if future and not future.done():
                        if value.get('ok'):
                            future.set_result(value.get('result'))
                        else:
                            future.set_exception(RuntimeError(value.get('error', 'send_failed')))
                elif value['op'] == 'event':
                    event = value['event']
                    if len(str(event.get('content', ''))) > 4000:
                        event['content'] = '帮助'
                    self.runtime.enqueue(event)
                    self.emit({'op': 'ack', 'id': value['id']})
                    self.wakeup.set()
            except (ValueError, KeyError):
                LOG.warning('invalid_gateway_input')

    def allowance_text(self, user_id):
        q = self.store.allowance(user_id)
        return f"今日已用 {q['used']}/3 次，待核对 {q['reserved']} 次，剩余 {q['remaining']} 次。北京时间 00:00 重置。"

    async def handle(self, event):
        uid, message_id = str(event['author_id']), event['msg_id']
        text = re.sub(r'\(met\).*?\(met\)', '', str(event.get('content', ''))).strip()
        if not text:
            return
        previous = self.store.claim(message_id)
        if previous:
            await self.send(self.receipt_text(previous), message_id)
            return
        if text in ('帮助', '菜单', '/帮助', 'help'):
            await self.send(HELP, message_id)
            return
        if text in ('我的次数', '次数', '额度'):
            await self.send(self.allowance_text(uid) if self.store.binding(uid) else '请先发送「绑定 游戏角色名」。', message_id)
            return
        snapshot = self.bridge.snapshot()
        if text in ('状态', '世界进度', '服务器状态'):
            await self.send(self.status_text(snapshot), message_id)
            return
        match = re.fullmatch(r'/?绑定(?:\s+(.+))?', text)
        if match:
            if not snapshot.get('capabilities', {}).get('binding'):
                await self.send('游戏内绑定采集尚未就绪，管理员完成启用后即可绑定。物品申请当前不会执行。', message_id)
                return
            target = (match[1] or '').strip()
            players = snapshot['players']
            selected = [p for p in players if p['name'] == target or p['player_uid'] == target.upper()]
            if len(selected) != 1:
                await self.send('请发送「绑定 游戏角色名」。当前在线：' + ('、'.join(p['name'] for p in players) or '无人') + '\n角色名重复时请联系管理员核对。', message_id)
                return
            player = selected[0]
            code = self.runtime.challenge(uid, player['player_uid'], message_id)
            await self.send(f"请使用角色「{player['name']}」在游戏聊天框输入：\n!bind {code}\n验证码 10 分钟有效，验证成功后会在这里通知。", message_id)
            return
        binding = self.store.binding(uid)
        if not binding:
            await self.send('申请物品前请先发送「绑定 游戏角色名」，确认发给你自己的角色。\n' + HELP, message_id)
            return
        player = next((p for p in snapshot['players'] if p['player_uid'] == binding['player_uid'] and p['account_id'] == binding['account_id']), None)
        if not player:
            await self.send('你的绑定角色当前不在线。上线后再申请，本次不扣次数。', message_id)
            return
        world = {key: snapshot.get(key) for key in ('observed_at', 'world_level', 'world_day', 'base_count', 'source', 'game_version')}
        world['player_level'] = player['level']
        food = self.prepare_food(text, event, binding, world)
        if food and food.get('reply'):
            await self.send(food['reply'], message_id)
            return
        selected = food.get('selection') if food else None
        if selected:
            quantity = food['quantity']
            await self.send(f"已为你选择适合当前进度的普通食品：{selected['name']} × {quantity}。正在由 gpt-6-astra 审核。", message_id)
            candidates = [{**selected, 'assistance_selection': {'quantity': quantity, 'kind': 'ordinary_food'}}]
        else:
            await self.send('已接收 · 正在核对世界进度，并由 gpt-6-astra 审核物资申请。', message_id)
            candidates = self.candidates(text, world)
        model_text = food.get('model_text', text) if food else text
        decision = await self.model.decide(model_text, world, candidates)
        if decision['intent'] != 'request':
            # The bot owns its catalogue. Even if the model unexpectedly asks
            # for a directory, provide the verified recommendation ourselves.
            await self.send(self.food_options(food['options'], selected, quantity) if selected else decision['reply'], message_id)
            return
        if not decision['approved']:
            if selected:
                self.finish_food(event, message_id)
            self.store.record_denial(message_id, uid, decision['reason'], text, decision)
            await self.send('本次未批准：' + decision['reason'] + '\n未扣次数。', message_id, 'warning')
            return
        if selected and decision['items'] != [{'item_id': selected['id'], 'quantity': quantity}]:
            self.finish_food(event, message_id)
            self.store.record_denial(message_id, uid, '食品审核结果与原申请数量不一致。', text, decision)
            await self.send('食品审核结果与原申请不一致，未发放、不扣次数。请重新申请。', message_id, 'warning')
            return
        # Refresh actual state after a slow model response; an old snapshot cannot approve inventory changes.
        snapshot = self.bridge.snapshot()
        current = next((p for p in snapshot['players'] if p['player_uid'] == binding['player_uid'] and p['account_id'] == binding['account_id']), None)
        if not current:
            if selected:
                self.finish_food(event, message_id)
            await self.send('审核期间角色已离线，本次未发放、不扣次数。', message_id)
            return
        world.update({key: snapshot.get(key) for key in ('observed_at', 'world_level', 'world_day', 'base_count', 'source', 'game_version')})
        world['player_level'] = current['level']
        plan = evaluate_request(self.catalog, decision['items'], world)
        if not plan['approved']:
            if selected:
                self.finish_food(event, message_id)
            self.store.record_denial(message_id, uid, plan['reason'], text, {'model': decision, 'policy': plan})
            await self.send('本次未批准：' + plan['reason'] + '\n未扣次数。', message_id, 'warning')
            return
        if selected:
            # Close the short-answer continuation before any inventory call.
            # A later "10份" / "换一个" must never repeat this claim.
            self.finish_food(event, message_id)
            plan['food_selection'] = {'item_id': selected['id'], 'name': selected['name'], 'quantity': quantity}
        result = await self.delivery.grant(message_id, uid, plan['items'], requested_text=text, decision={'model': decision, 'policy': plan})
        await self.send(self.receipt_text(result), message_id, 'success' if result['state'] == 'submitted' else 'warning')

    def candidates(self, text, world=None):
        result = self.catalog.search(text, limit=60)
        if world and FOOD_TOPIC.search(text):
            seen = {item['id'] for item in result}
            result += [item for item in available_basic_foods(self.catalog, world) if item['id'] not in seen]
        return result

    @staticmethod
    def food_key(event):
        # This bot serves one configured channel, but retain the channel in the
        # key as well so future multi-channel routing cannot share suggestions.
        return 'food_suggestion:' + str(event.get('target_id', event.get('channel_id', ''))) + ':' + str(event['author_id'])

    @staticmethod
    def food_options(options, selected=None, quantity=None, *, pending=False, completed=False):
        selected = selected or options[0]
        lines = ['当前可选的普通食品：' + '、'.join(item['name'] for item in options[:5]) + '。',
                 f"推荐：{selected['name']}。"]
        if completed:
            lines.append('上次申请已处理；换推荐不会再次发放。需要新的补给请重新明确申请。')
        elif pending:
            lines.append('想领取多少份？直接回复「10份」即可；也可说「换一个」。')
        else:
            lines.append(f"可直接说「申请{selected['name']} {quantity or 10}份」；也可说「换一个」看看其他推荐。")
        return '\n'.join(lines)

    def prepare_food(self, text, event, binding, world):
        """Resolve only safe ordinary-food requests and scoped short answers."""
        key = self.food_key(event)
        pending = self.runtime.get(key)
        if not isinstance(pending, dict) or pending.get('player_uid') != binding['player_uid'] or pending.get('account_id') != binding['account_id'] or pending.get('expires_at', 0) <= time.time():
            pending = None
        intent = food_intent(text)
        change = text.strip(' 。！!，,') in ('换一个', '换一种', '换个', '下一个')
        short_quantity = quantity_followup(text)
        is_followup = intent is None and short_quantity is not None and pending and pending.get('awaiting_quantity') and not pending.get('claim_message_id')
        if not intent and not is_followup and not change:
            if short_quantity is not None:
                return {'reply': '请说明要申请的物品，例如「申请食物 10 份」。此前的领取不会因重复数量再次执行。'}
            # Any substantive new message cancels the incomplete food request.
            if pending and pending.get('awaiting_quantity'):
                self.runtime.put(key, None)
            return None
        if change and not pending:
            return {'reply': '可发送「有什么食物」查看当前推荐，或直接说「申请食物 10 份」。'}
        options = available_basic_foods(self.catalog, world)
        if not options:
            known = self.catalog.basic_foods()
            explanation = evaluate_request(self.catalog, [{'item_id': known[0]['id'], 'quantity': 1}], world)['reason'] if known else '机器人的普通食品资料暂不可用，需要更新服务器资料。'
            return {'reply': explanation + '\n本次未发放，不扣次数。'}
        completed = bool(change and pending.get('claim_message_id'))
        selected = options[0]
        if (change or is_followup) and pending:
            ids = [item['id'] for item in options]
            index = ids.index(pending['selected_id']) if pending.get('selected_id') in ids else -1
            selected = options[(index + 1) % len(options)] if change else options[max(index, 0)]
        quantity = short_quantity if is_followup else intent['quantity'] if intent else None
        awaiting_quantity = bool((intent and intent['kind'] == 'request' and quantity is None) or (change and pending.get('awaiting_quantity') and not completed))
        context = {'player_uid': binding['player_uid'], 'account_id': binding['account_id'],
                   'selected_id': selected['id'], 'expires_at': time.time() + 600,
                   'awaiting_quantity': awaiting_quantity, 'claim_message_id': pending.get('claim_message_id') if completed else None}
        self.runtime.put(key, context)
        if change or (intent and intent['kind'] == 'browse') or quantity is None:
            return {'reply': self.food_options(options, selected, pending=awaiting_quantity, completed=completed)}
        model_text = f"用户此前明确申请普通食物但缺数量；现在回复「{text}」，即申请{selected['name']} {quantity}份。" if is_followup else text
        return {'selection': selected, 'quantity': quantity, 'options': options, 'model_text': model_text}

    def finish_food(self, event, message_id):
        key = self.food_key(event)
        pending = self.runtime.get(key)
        if isinstance(pending, dict):
            pending.update(awaiting_quantity=False, claim_message_id=message_id)
            self.runtime.put(key, pending)

    def receipt_text(self, claim):
        lines = []
        status = {'submitted': '已提交发放，请核对游戏背包。', 'partial': '部分物品已提交，其余未发放。',
                  'failed': '已确认未发放，不扣次数。', 'unknown': '发放结果待核对，暂保留次数，请勿重复申请。',
                  'in_progress': '游戏仍在处理，暂保留次数。', 'reserved': '申请仍待处理。', 'denied': '本次未批准：' + claim.get('reason', '')}
        lines.append(status.get(claim['state'], '正在核对发放结果。'))
        states = {'submitted': '已提交', 'failed': '未发放', 'skipped': '未发放', 'unknown': '待核对', 'pending': '处理中', 'sending': '待核对', 'queued': '未提交'}
        for item in claim.get('deliveries', []):
            lines.append(f"{item.get('name') or item['item_id']} × {item['quantity']} · {states.get(item['state'], item['state'])}")
        if claim.get('user_id') and self.store.binding(claim['user_id']):
            lines.append(self.allowance_text(claim['user_id']))
        return '\n'.join(lines)

    @staticmethod
    def status_text(snapshot):
        names = '、'.join(p['name'] for p in snapshot['players']) or '无人'
        return f"世界第 {snapshot.get('world_day', '?')} 天 · {snapshot.get('base_count', '?')} 座基地\n在线：{names}\n已观测玩家最高等级：{snapshot.get('world_level', '?')}（不是完整科技解锁进度）\n每日物资申请：每位绑定玩家 3 次，北京时间零点重置。"

    async def work_loop(self):
        while not self.stopping.is_set():
            event = self.runtime.next()
            if not event:
                self.wakeup.clear()
                try:
                    await asyncio.wait_for(self.wakeup.wait(), 2)
                except asyncio.TimeoutError:
                    pass
                continue
            try:
                await self.handle(event)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                LOG.warning('request_failed:%s', type(error).__name__)
                claim = self.store.claim(event['msg_id'])
                try:
                    await self.send(self.receipt_text(claim) if claim else '暂时无法完成处理，本次尚未提交发放、不扣次数。请稍后再试。', event['msg_id'], 'warning')
                except Exception:
                    LOG.warning('reply_failed')
            self.runtime.done(event['msg_id'])

    async def process_game_event(self, event):
        if not self.runtime.allow_event_delivery(event.get('id', event.get('source_event_id', 'unknown'))):
            LOG.warning('event_notification_abandoned_after_retries')
            return
        if event['type'] == 'binding':
            proof = self.runtime.proof(event.get('code', ''), event.get('player_uid', ''))
            if not proof:
                return
            player = next((p for p in self.bridge.snapshot()['players'] if p['player_uid'] == proof['player_uid']), None)
            if not player or not player.get('account_id'):
                return
            try:
                self.store.bind_verified(proof['user_id'], player['player_uid'], player['account_id'], player['name'])
                text = f"已绑定游戏角色「{player['name']}」。现在可以直接申请物资。\n" + self.allowance_text(proof['user_id'])
            except BindingConflict as error:
                text = str(error)
            await self.send(text, proof['quote'])
            self.runtime.consume_proof(proof['digest'])
        else:
            text = event_text(event)
            if text:
                await self.send(text)

    async def poll_loop(self):
        while not self.stopping.is_set():
            try:
                await asyncio.to_thread(self.bridge.poll)
                self.health.update(last_game_poll=time.time(), last_error=None)
                cursor = self.runtime.get('event_cursor', 0)
                for event in self.bridge.events(after=cursor, limit=100):
                    await self.process_game_event(event)
                    self.runtime.put('event_cursor', event['id'])
            except asyncio.CancelledError:
                raise
            except Exception as error:
                self.health['last_error'] = type(error).__name__
                LOG.warning('game_poll_failed:%s', type(error).__name__)
            tmp = self.state / 'health.tmp'
            tmp.write_text(json.dumps(self.health), encoding='utf-8')
            tmp.replace(self.state / 'health.json')
            await asyncio.sleep(5)

    async def reconcile_loop(self):
        while not self.stopping.is_set():
            for claim in self.store.unresolved_claims():
                try:
                    updated = await self.delivery.reconcile(claim['message_id'])
                    if updated['state'] != claim['state']:
                        await self.send(self.receipt_text(updated), claim['message_id'])
                except Exception as error:
                    LOG.warning('reconcile_failed:%s', type(error).__name__)
            await asyncio.sleep(20)

    async def run(self):
        tasks = [asyncio.create_task(fn()) for fn in (self.input_loop, self.work_loop, self.poll_loop, self.reconcile_loop)]
        stop = asyncio.create_task(self.stopping.wait())
        try:
            done, _ = await asyncio.wait([*tasks, stop], return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                if task is not stop:
                    task.result()
                    if not self.stopping.is_set():
                        raise RuntimeError('background_worker_exited')
        finally:
            for task in [*tasks, stop]:
                task.cancel()
            await asyncio.gather(*tasks, stop, return_exceptions=True)


if __name__ == '__main__':
    os.umask(0o077)
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format='%(asctime)s %(levelname)s %(message)s')
    # A second process must not reconcile a live process's queued recipe lines.
    state = Path(os.environ.get('STATE_DIR', './data'))
    state.mkdir(parents=True, exist_ok=True)
    lock_file = (state / 'bot.lock').open('a')
    if os.name == 'posix':
        import fcntl
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    bot = Bot()
    asyncio.run(bot.run())
