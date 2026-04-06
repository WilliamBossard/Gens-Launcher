 Patch Notes - Structure & Stability Update
 Architecture & Optimization
Full Modularization: Code has been extracted from the massive renderer.js file and redistributed into specialized modules (auth.js, instances.js, uiCore.js, etc.) for easier maintenance.

New UI Core (uiCore.js): Created a centralized engine to manage displays, toast notifications, loading states, and database queries.

Secure Paths: Migrated all user data (instances, settings, accounts) to the standard %AppData%/GensLauncher folder to prevent data loss during code updates.

 Account Management (Auth)
Account Persistence: Fixed UTF-8 encoding issues when writing JSON files, preventing accounts from disappearing upon restart.

Dynamic Dropdown Menu: The account selector (top right) now updates instantly whenever a profile is added, deleted, or switched.

Microsoft Flow Fix: Stabilized the Device Code login system with automatic cleanup of active sessions.

 Instances & Gameplay
Icon Auto-Detection: The launcher now automatically scans the instance folder for an icon.png or icon.jpg file if no custom icon is set.

Multi-Instance Fix: The "Launch" button no longer switches to "Force Quit" on other instances when the multi-launch option is enabled in settings.

Form Cleanup: Fields (name, version, RAM) are now automatically reset when opening the "Add Instance" window to avoid duplicate data.

 User Interface (UI)
Tab Refresh: Clicking on "Mods," "Shaders," or "Resource Packs" tabs now forces a real-time refresh of the folder contents.

Smart Search Bar:

Fixed the search filter for local mods.

Automatic clearing of search text when closing windows to prevent empty lists upon reopening.

News System: Fixed a bug where Minecraft news would sometimes remain hidden by default.

 Network & Server
New Status Engine: Switched to the mcstatus.io API for the favorite server, providing better compatibility with anti-DDoS protections and more reliable detection.

IP Sanitization: Added an automatic .trim() function to server addresses to ignore accidental leading or trailing spaces.
