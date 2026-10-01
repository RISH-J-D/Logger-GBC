# Struzon Monitor - Windows Credential Provider

This directory contains the boilerplate code required to build a custom V2 Credential Provider for Windows. A Credential Provider hooks into LogonUI.exe and replaces the default Windows login screen.

## Warning
**Proceed with extreme caution.** A poorly implemented Credential Provider can cause LogonUI to crash, permanently locking you out of Windows. Always test in a Virtual Machine and keep a backdoor administrative account or recovery media available.

## Architecture
To fully implement this:
1. You must implement the `ICredentialProvider` and `ICredentialProviderCredential` COM interfaces.
2. The credential provider will present a custom tile for the Struzon Monitor.
3. Upon entering the Emp ID and Password, the provider will make a WinHTTP request to `http://localhost:4000/api/agent/login`.
4. If successful, it must pass the underlying Windows account credentials to the OS so Windows can actually log the user in (e.g. using `KERB_INTERACTIVE_LOGON`). This requires mapping the Emp ID to a local Windows account.

## Compiling
Due to the complexity of COM interfaces and Windows SDK dependencies, this module **must** be compiled on a Windows machine using Visual Studio.

1. Install Visual Studio 2022 with "Desktop development with C++".
2. Create a new "Dynamic-Link Library (DLL)" project.
3. Include the `credentialprovider.h` header from the Windows SDK.
4. Implement the COM interfaces (see Microsoft's official `V2CredentialProviderSample` on GitHub for a full template).
5. Add WinHTTP logic to perform the POST request.

## Registration
Once compiled into `StruzonCredProvider.dll`:
1. Copy the DLL to `C:\Windows\System32\`.
2. Register the COM object using `regsvr32.exe StruzonCredProvider.dll`.
3. The provider will be active on the next reboot or lock screen (`Win+L`).
