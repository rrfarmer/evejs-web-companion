# Standalone Operations Center

Choose **UOC** in Web Companion’s pinned plugins or the **Plugins** menu to open `/uoc/` in a separate browser tab. Each center has a bookmarkable URL. `npm run build:web` and `node plugins/uoc/build-page.mjs --with-core` build the same WC entry, including the registered UOC page.

The pilot picker reads the linked Web Companion tab’s roster and the accounts and characters saved in
this browser’s Pilot Hangar. A direct link can use saved Hangar accounts too. UOC reads a linked
account’s roster with its current page session. For a saved offline account, it uses Web Companion’s
existing account-only access on demand. Pilots already listed in Hangar can be selected in UOC
without a second sign-in prompt.

MCC fleet definitions, Distribution operations and the Distribution carrier pool are shared by every
signed-in account in the same Web Companion world. A fleet can include pilots from several accounts.
Switching the active account or reopening UOC shows the same saved operations. Any signed-in account
in that world can manage them. Pilot commands still use the pilot’s verified account and the
existing Bot Host controls.

When you add a Distribution carrier, UOC checks the character against Web Companion’s current roster
for the selected account. The shared pool records the character ID. A plugin route receives the
caller’s account but has no server-side lookup for an offline character’s owner. Sending a name to
the roster route cannot reserve that character for an account. When Bot Host connects the carrier,
UOC verifies the character against that session’s roster and records its account. Reopening the
page or closing the linked tab leaves hosted pilots running.
