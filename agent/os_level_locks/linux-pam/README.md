# Struzon Monitor - Linux PAM Integration

This folder contains a custom PAM (Pluggable Authentication Module) script to require authentication against the Struzon Monitor server at the OS login screen.

## Warning
**Proceed with extreme caution.** Modifying PAM configuration can permanently lock you out of your system. It is highly recommended to keep a root terminal open while testing.

## Prerequisites
1. Ensure Python 3 is installed.
2. The user attempting to log in must exist as a local UNIX user, and their UNIX username MUST match their Struzon Emp ID (e.g., `STZ002`).

## Installation

1. Copy the script to a secure location and make it executable:
   ```bash
   sudo cp pam_struzon_auth.py /usr/local/bin/pam_struzon_auth.py
   sudo chmod 700 /usr/local/bin/pam_struzon_auth.py
   sudo chown root:root /usr/local/bin/pam_struzon_auth.py
   ```

2. Edit your PAM configuration file (e.g., `/etc/pam.d/common-auth` or `/etc/pam.d/gdm-password` depending on your distro).

3. Add the following line to the **TOP** of the auth block:
   ```text
   auth required pam_exec.so expose_authtok /usr/local/bin/pam_struzon_auth.py
   ```

   *Note: Using `required` means the login will fail if the server denies the login OR if the server is unreachable. If you want it to fall back to normal OS login if the server is unreachable, you would need to modify the Python script to return `0` on network errors.*

4. Test logging in from a new TTY (Ctrl+Alt+F3) or the lock screen. You will only be allowed in if the Struzon server approves the credentials.
