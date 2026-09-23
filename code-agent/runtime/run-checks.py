#!/usr/bin/python3
"""Trusted image entrypoint. Candidate programs run only inside this container."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

PROJECTS = ('ai-bot', 'quota-dashboard', 'music-bot', 'code-agent')

def valid_test_path(value, project):
    if not isinstance(value, str) or not value:
        return False
    try:
        if len(value.encode('utf-8')) > 1024:
            return False
    except UnicodeError:
        return False
    parts = value.split('/')
    if (len(parts) < 2 or len(parts) > 13 or parts[0] not in ('test', 'tests')
            or re.search(r'[\x00-\x1f\x7f\\:*?"<>|]', value)
            or any(part in ('', '.', '..') or part.endswith(('.', ' ')) or len(part.encode('utf-8')) > 255 for part in parts)):
        return False
    name = parts[-1]
    if project == 'code-agent':
        # unittest imports dotted module paths. Unicode, spaces and hyphens are
        # valid importlib names; additional dots would address another module.
        return name.startswith('test_') and name.endswith('.py') and not any('.' in part for part in [*parts[:-1], name[:-3]])
    # Node interprets its positional test arguments as globs. A literal file
    # such as [a].test.js must not produce evidence for the different a.test.js.
    return not re.search(r'[\[\]{}()]', value) and name.endswith(('.test.js', '.test.cjs', '.test.mjs', '.spec.js', '.spec.cjs', '.spec.mjs'))

def main():
    if len(sys.argv) < 2 or sys.argv[1] not in (*PROJECTS, 'all'):
        return 2
    project, files = sys.argv[1], sys.argv[2:]
    if project == 'all' and files or len(files) > 50:
        return 2
    for value in files:
        if not valid_test_path(value, project):
            return 2
    # /work is a root-owned tmpfs mount. Copy into a user-owned subdirectory so
    # copytree can preserve timestamps and permissions without chmod on the mount.
    source = Path('/input'); work = Path('/work/repo')
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
