# Standalone Operations Center

Choose **UOC** in Farmer’s pinned plugins or the **Plugins** menu to open `/uoc/` in a separate browser tab. Each center has a bookmarkable URL. `npm run build:web` and `node plugins/uoc/build-page.mjs --with-core` build the same WC entry, including the registered UOC page.

UOC lists accounts from the linked WC tab’s current plugin-page roster and this browser’s saved account directory. A direct link can still use saved accounts. When a view needs account access, UOC uses the existing WC account-only login. That authorization stays in the UOC tab’s memory and leaves the linked tab’s pilot under its existing owner. UOC verifies the current roster and control before starting an operation.

WC Bot Host and the existing owner services handle gameplay sessions. A pilot already controlled by another browser tab keeps its owner. Distribution workspaces remain scoped to their respective owners.
