"""Stage the additive MinimalGive observer. Does NOT restart/reload the game.

Run locally on the game host during deployment; then the operator coordinates
one restart. Repeated staging is idempotent. Existing item/catch logic remains.
"""
import argparse
from pathlib import Path
import re
import shutil


def stage(scripts: Path, enable_deaths=False):
    main, logic = scripts / "main.lua", scripts / "libs/logic.lua"
    main_text, logic_text = main.read_text(encoding="utf-8"), logic.read_text(encoding="utf-8")
    marker = "-- KOOK telemetry integration v1"
    needle = "local text = Message:get():ToString()"
    if marker not in logic_text and logic_text.count(needle) != 1:
        raise RuntimeError("Chat hook differs from tested MinimalGive; review manually")
    if marker not in logic_text:
        logic_text = logic_text.replace(needle, needle + "\n    " + marker +
            '\n    pcall(function() require("modules/kook_telemetry").onChat(pc, text) end)')
    if marker not in main_text:
        main_text += '\n' + marker + '\nlocal kookOk, kookErr = pcall(function()\n' + \
            '    require("modules/kook_telemetry").start({deaths=' + ("true" if enable_deaths else "false") + '})\n' + \
            'end)\nif not kookOk then io.stderr:write("[MinimalGive] KOOK telemetry unavailable\\n") end\n'
    else:
        main_text = re.sub(r'(require\("modules/kook_telemetry"\)\.start\(\{deaths=)(true|false)(\}\))',
                           lambda m: m[1] + ("true" if enable_deaths else "false") + m[3], main_text)
    for target, content in ((main, main_text), (logic, logic_text)):
        backup = target.with_suffix(target.suffix + ".pre-kook")
        if not backup.exists():
            shutil.copy2(target, backup)
        target.write_text(content, encoding="utf-8")
    shutil.copy2(Path(__file__).with_name("kook_telemetry.lua"), scripts / "modules/kook_telemetry.lua")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("scripts", type=Path)
    parser.add_argument("--enable-deaths", action="store_true")
    args = parser.parse_args()
    stage(args.scripts, args.enable_deaths)
    print("Telemetry files staged; running game remains unchanged until a coordinated restart.")
