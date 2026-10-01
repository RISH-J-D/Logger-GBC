#!/usr/bin/env python3
import sys
import os
import urllib.request
import urllib.parse
import json

# This script is meant to be called by pam_exec.so with expose_authtok
# It reads the password from stdin and the username from the PAM_USER environment variable.

SERVER_URL = "http://localhost:4000"

def main():
    # Read password from stdin (pam_exec passes it via stdin when expose_authtok is set)
    password = sys.stdin.read().rstrip('\0').rstrip('\n')
    username = os.environ.get('PAM_USER', '')

    if not username or not password:
        sys.exit(1) # Authentication failed

    # Attempt to log in to the Struzon Monitor server
    try:
        url = f"{SERVER_URL}/api/agent/login"
        data = json.dumps({
            "username": username,
            "password": password,
            "hostname": os.uname().nodename,
            "platform": "linux"
        }).encode('utf-8')
        
        req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=5) as response:
            result = json.loads(response.read().decode('utf-8'))
            
            if result.get('ok') is True and result.get('monitoring_enabled') is not False:
                # Login successful and monitoring is enabled
                sys.exit(0)
            else:
                # Login failed or monitoring is stopped
                sys.exit(1)
    except Exception as e:
        # Failsafe: if the server is unreachable, we fail authentication.
        # Warning: if the server is permanently down, you will be locked out.
        sys.exit(1)

if __name__ == '__main__':
    main()
