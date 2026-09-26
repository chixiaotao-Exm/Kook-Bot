"""Trusted check inventory, shared by the broker and copied into the sandbox image."""
PROJECTS = ('ai-bot', 'quota-dashboard', 'music-bot', 'code-agent', 'bridge-bot', 'ops-center', 'menu-bot')
NODE_PROJECTS = tuple(name for name in PROJECTS if name != 'code-agent')
DEPENDENCY_PROJECTS = ('ai-bot', 'quota-dashboard', 'music-bot')
CHECK_PROTOCOL = 'kook-checks-v3-seven-projects'
