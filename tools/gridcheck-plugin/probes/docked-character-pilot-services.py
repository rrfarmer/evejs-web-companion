import blue
from carbonui.uicore import uicore
from eve.client.script.ui.shared.neocom.characterSheetWindow import CharacterSheetWindow, charsheet_expanded_setting
from eve.client.script.ui.shared.neocom.charsheet import PANEL_PLEX, GetPanelName
from eve.client.script.ui.shared.inventory.plexVault import PlexVaultActions
from eve.client.script.ui.shared.pointerTool.pointerChains import FindChainForPointer
from localization import GetByLabel


def find_child(parent, cls):
    for child in getattr(parent, 'children', ()):
        if isinstance(child, cls):
            return child
        match = find_child(child, cls)
        if match:
            return match


def observe():
    opened = CharacterSheetWindow.GetIfOpen()
    if not opened:
        uicore.cmd.OpenCharactersheet()
    window = CharacterSheetWindow.GetIfOpen()
    previous = window.GetDefaultPanelID()
    expanded = charsheet_expanded_setting.is_enabled()
    try:
        window._UpdateCharacterSheetExpanded(True, animate=False)
        window._StartLoadingPanel(PANEL_PLEX, autoExpand=True)
        panel = window.plexPanel
        for _ in range(80):
            if panel.display and getattr(panel, 'multipleQueueLabel2', None) and panel.subscriptionHeaderLabel.text:
                break
            blue.synchro.SleepWallclock(100)
        else:
            raise RuntimeError('Pilot Services did not load')
        tab = window.mainTabGroup.GetTabByID(PANEL_PLEX)
        actions = find_child(panel, PlexVaultActions)
        return dict(build=3698585, station=session.stationid, panel=PANEL_PLEX, label=GetPanelName(PANEL_PLEX),
                    pointer=tab.uniqueUiName, chain=repr(FindChainForPointer(tab.uniqueUiName)),
                    balance=actions.controller.balance, cards=[GetByLabel('UI/PlexVault/' + label) for label in
                        ('SellPlexForIsk', 'AddOmegaTime', 'BuyMultipleTraining', 'OpenNewEdenStore', 'BuyPlexForMoney')],
                    cardCount=len(actions.children), headers=[GetByLabel('UI/CharacterSheet/CharacterSheetWindow/PilotLicense/' + label)
                        for label in ('CloneState', 'MultipleCharacterTitle')],
                    clone=dict(text=panel.subscriptionHeaderLabel.text, details=panel.subscriptionDescriptionLabel.text,
                               icon=panel.cloneState.icon.texturePath, time=panel.GetOmegaTime()),
                    slots=dict(sm.GetService('skillqueue').GetMultipleCharacterTraining()),
                    rows=[dict(text=label.text, expires=expiry.text if expiry.display else None) for label, expiry in
                          ((panel.multipleQueueLabel1, panel.multipleQueueExpiryLabel1),
                           (panel.multipleQueueLabel2, panel.multipleQueueExpiryLabel2))])
    finally:
        if opened:
            window._StartLoadingPanel(previous)
            window._UpdateCharacterSheetExpanded(expanded, animate=False)
        else:
            window.Close()
        settings.char.ui.Set('charSheetSelectedPanel', previous)


result = observe()
