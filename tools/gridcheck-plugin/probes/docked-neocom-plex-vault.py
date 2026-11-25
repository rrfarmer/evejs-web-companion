import blue
from eve.client.script.ui.shared.inventory.invWindow import Inventory, InventoryPrimary, PlexVaultWindow
from eve.client.script.ui.shared.inventory.plexVault import PlexVaultController
from neocom2.btnIDs import PLEX_VAULT_ID


def observe():
    service = sm.GetService('neocom')
    primary_id = Inventory.GetWindowIDPrimary()
    before_primary = InventoryPrimary.GetIfOpen(windowID=primary_id)
    before_secondary = PlexVaultWindow.GetIfOpen()
    if before_primary or before_secondary:
        return {'alreadyOpen': True}
    try:
        panel = service.ShowEveMenu()
        rows = [entry for entry in panel.main.children if hasattr(entry, 'btnData')]
        entry = next(row for row in rows if row.btnData.id == PLEX_VAULT_ID)
        result = {'station': session.stationid, 'label': entry.GetLabel(), 'index': rows.index(entry),
                  'command': entry.btnData.cmdName, 'icon': entry.btnData.iconPath}
        entry.OnClick()
        window = None
        for _ in xrange(40):
            window = InventoryPrimary.GetIfOpen(windowID=primary_id) or PlexVaultWindow.GetIfOpen()
            if window and getattr(window, 'currInvID', None):
                break
            blue.synchro.SleepWallclock(100)
        if window:
            result.update({'windowID': window.windowID, 'selected': window.currInvID,
                           'primary': isinstance(window, InventoryPrimary),
                           'balance': PlexVaultController().balance})
        return result
    finally:
        service.CloseAllPanels()
        for window in (InventoryPrimary.GetIfOpen(windowID=primary_id), PlexVaultWindow.GetIfOpen()):
            if window:
                window.Close()


result = observe()
