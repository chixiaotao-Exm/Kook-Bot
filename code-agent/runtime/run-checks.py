#!/usr/bin/python3
"""Trusted image entrypoint. Candidate programs run only inside this container."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

PROJECTS = ('ai-bot', 'quota-dashboard', 'music-bot', 'code-agent')

def main():
    if len(sys.argv) < 2 or sys.argv[1] not in (*PROJECTS, 'all'):
        return 2
    project, files = sys.argv[1], sys.argv[2:]
    if project == 'all' and files:
        return 2
    for value in files:
        parts = value.split('/')
        if (len(value) > 240 or any(part in ('', '.', '..') for part in parts)
                or parts[0] not in ('test', 'tests') or not re.fullmatch(r'[A-Za-z0-9_./-]+', value)):
            return 2
    source = Path('/input'); work = Path('/work')
    if not source.is_dir() or os.getuid() == 0:
        return 2
    shutil.copytree(source, work, dirs_exist_ok=True)
    for name in PROJECTS[:3]:
        dependency = work / name / 'node_modules'
        if dependency.exists() or dependency.is_symlink():
            raise RuntimeError('Unexpected dependency folder in input')
        if (work / name).is_dir():
            dependency.symlink_to(Path('/opt/deps') / name / 'node_modules', target_is_directory=True)
    os.environ['TEST_FFMPEG_PATH'] = '/usr/bin/ffmpeg'
    os.environ['CI'] = 'true'
    os.environ.pop('NODE_OPTIONS', None)
    selected = PROJECTS if project == 'all' else (project,)
    code = 0
    for name in selected:
        directory = work / name
        if not directory.is_dir():
            print(f'Missing project: {name}', flush=True)
            code = 1; continue
        print(f'PROJECT_CHECK {name}', flush=True)
        commands = []
        if name == 'code-agent':
            commands = [['/usr/bin/python3', '-m', 'unittest', *(value[:-3].replace('/', '.') for value in files)]] if files else [
                ['/usr/bin/python3', '-m', 'unittest', 'discover', '-s', 'tests', '-v']]
        else:
            if name == 'music-bot' and not files:
                commands.append(['node', 'scripts/build-web.js'])
            commands.append(['node', '--test', '--test-concurrency=1', *files])
            if name == 'music-bot' and not files:
                commands.append(['/opt/python/bin/python', 'qq/test_provider.py'])
        for command in commands:
            result = subprocess.run(command, cwd=directory, check=False)
            if result.returncode:
                code = 1
    return code

if __name__ == '__main__':
    sys.exit(main())
