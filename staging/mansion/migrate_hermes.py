#!/usr/bin/env python3
import os
import sys
import shutil
import subprocess
from pathlib import Path

HERMES_HOME = Path('/home/mars/.hermes')
MANSION_HERMES = Path('/mnt/mansion/hermes')

EXCLUDE_NAMES = {'hermes-agent', '.', '..'}

def run_cmd(args, check=True, capture=True, env=None):
    try:
        res = subprocess.run(args, capture_output=capture, text=True, check=check, env=env)
        return res.returncode, res.stdout, res.stderr
    except subprocess.CalledProcessError as e:
        if check:
            print(f"Error executing command {' '.join(args)}: {e.stderr}")
            raise
        return e.returncode, e.stdout, e.stderr
    except Exception as e:
        print(f"Failed to run command {' '.join(args)}: {e}")
        if check:
            raise
        return -1, "", str(e)

def stop_services():
    print("Stopping hermes-dashboard and hermes-gateway services...")
    run_cmd(['systemctl', '--user', 'stop', 'hermes-dashboard.service', 'hermes-gateway.service'], check=False)

def start_services():
    print("Starting hermes-dashboard and hermes-gateway services...")
    run_cmd(['systemctl', '--user', 'start', 'hermes-dashboard.service', 'hermes-gateway.service'], check=False)

def check_status():
    print("=== Hermes Status Check ===")
    if not HERMES_HOME.exists():
        print(f"Error: {HERMES_HOME} does not exist.")
        return False
    
    symlinked = []
    physical = []
    
    for item in HERMES_HOME.iterdir():
        if item.name in EXCLUDE_NAMES:
            continue
        if item.is_symlink():
            target = item.resolve()
            symlinked.append((item.name, target))
        else:
            physical.append(item.name)
            
    print(f"Total symlinked items: {len(symlinked)}")
    for name, target in symlinked[:5]:
        print(f"  [SYMLINK] {name} -> {target}")
    if len(symlinked) > 5:
        print(f"  ... and {len(symlinked) - 5} more")
        
    print(f"Total physical items: {len(physical)}")
    for name in physical[:5]:
        print(f"  [PHYSICAL] {name}")
    if len(physical) > 5:
        print(f"  ... and {len(physical) - 5} more")
        
    # Check systemd status
    _, out, _ = run_cmd(['systemctl', '--user', 'is-active', 'hermes-dashboard.service', 'hermes-gateway.service'], check=False)
    print("Services active status:\n" + out.strip())
    return len(symlinked) > 0

def dry_run():
    print("=== Dry Run: Migrating to Mansion ===")
    if not HERMES_HOME.exists():
        print(f"Error: {HERMES_HOME} does not exist.")
        return
    
    print(f"Source: {HERMES_HOME}")
    print(f"Destination: {MANSION_HERMES}")
    
    to_move = []
    for item in HERMES_HOME.iterdir():
        if item.name in EXCLUDE_NAMES:
            continue
        if item.is_symlink():
            print(f"Skipping already symlinked item: {item.name} -> {item.readlink()}")
        else:
            to_move.append(item)
            
    print(f"Items to move ({len(to_move)} total):")
    for item in to_move:
        print(f"  - {item.name} ({'dir' if item.is_dir() else 'file'})")

def do_migration():
    print("=== Executing Migration to Mansion ===")
    if not HERMES_HOME.exists():
        print(f"Error: {HERMES_HOME} does not exist.")
        sys.exit(1)
        
    MANSION_HERMES.mkdir(parents=True, exist_ok=True)
    
    stop_services()
    
    to_move = []
    for item in HERMES_HOME.iterdir():
        if item.name in EXCLUDE_NAMES:
            continue
        if item.is_symlink():
            print(f"Skipping already symlinked item: {item.name} -> {item.readlink()}")
        else:
            to_move.append(item)
            
    for item in to_move:
        dst = MANSION_HERMES / item.name
        
        # If destination already exists, back up target in mansion
        if dst.exists() or dst.is_symlink():
            backup_dst = MANSION_HERMES / f"{item.name}.bak_{int(item.stat().st_mtime)}"
            print(f"Warning: Destination {dst} already exists. Backing up existing to {backup_dst}")
            if dst.is_dir() and not dst.is_symlink():
                shutil.move(str(dst), str(backup_dst))
            else:
                dst.unlink()
                
        print(f"Moving {item} to {dst}...")
        shutil.move(str(item), str(dst))
        
        print(f"Creating symlink {item} -> {dst}...")
        item.symlink_to(dst)
        
    print("Migration completed. Restarting services...")
    start_services()
    print("Services restarted.")

def do_rollback():
    print("=== Executing Rollback of Migration ===")
    if not HERMES_HOME.exists():
        print(f"Error: {HERMES_HOME} does not exist.")
        sys.exit(1)
        
    stop_services()
    
    links_to_restore = []
    for item in HERMES_HOME.iterdir():
        if item.name in EXCLUDE_NAMES:
            continue
        if item.is_symlink():
            target = Path(os.readlink(item))
            if MANSION_HERMES in target.parents or target.parent == MANSION_HERMES:
                links_to_restore.append((item, target))
                
    print(f"Found {len(links_to_restore)} symlinks to restore to local physical files/dirs.")
    
    for link, target in links_to_restore:
        print(f"Removing symlink {link}...")
        link.unlink()
        
        if target.exists():
            print(f"Moving {target} back to {link}...")
            shutil.move(str(target), str(link))
        else:
            print(f"Warning: Target {target} does not exist. Cannot restore content.")
            
    print("Rollback completed. Restarting services...")
    start_services()
    print("Services restarted.")

def do_smoke_test():
    print("=== Running Hermes Smoke Test ===")
    # Set path to include local bin wrapper
    env = os.environ.copy()
    env['PATH'] = f"/home/mars/.local/bin:{env.get('PATH', '')}"
    
    commands = [
        ['hermes', '--help'],
        ['hermes', 'version'],
        ['hermes', 'health']
    ]
    
    for cmd in commands:
        print(f"Running: {' '.join(cmd)}")
        code, out, err = run_cmd(cmd, check=False, env=env)
        print(f"Exit code: {code}")
        if out:
            print(f"Stdout (first 10 lines):\n" + '\n'.join(out.splitlines()[:10]))
        if err:
            print(f"Stderr (first 10 lines):\n" + '\n'.join(err.splitlines()[:10]))
        print("-" * 40)

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: migrate_hermes.py [status|dry-run|migrate|rollback|smoke]")
        sys.exit(1)
        
    action = sys.argv[1]
    if action == 'status':
        check_status()
    elif action == 'dry-run':
        dry_run()
    elif action == 'migrate':
        do_migration()
    elif action == 'rollback':
        do_rollback()
    elif action == 'smoke':
        do_smoke_test()
    else:
        print(f"Unknown action: {action}")
        sys.exit(1)
