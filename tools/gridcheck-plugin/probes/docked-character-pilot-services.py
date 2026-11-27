import blue
from carbonui.uicore import uicore
from carbonui.util.bunch import Bunch
from inventorycommon import const
from eve.client.script.ui.shared.neocom.characterSheetWindow import CharacterSheetWindow, charsheet_expanded_setting
from eve.client.script.ui.shared.neocom.charsheet import PANEL_PLEX, GetPanelName
from eve.client.script.ui.shared.inventory.plexVault import PlexVaultActions, Vault
from eve.client.script.ui.shared.pointerTool.pointerChains import FindChainForPointer
from localization import GetByLabel


def find_child(parent, cls):
    for child in getattr(parent, 'children', ()):
        if isinstance(child, cls):
            return child
        match = find_child(child, cls)
        if match:
            return match


def observe_vault_drop(vault):
    def row(item_id, type_id, group_id, units):
        return Bunch(item=Bunch(itemID=item_id, typeID=type_id, groupID=group_id, stacksize=units))

    deposits = []
    original = vault.controller.DepositPlex
    try:
        vault.controller.DepositPlex = lambda item_id, quantity: deposits.append([item_id, quantity])
        vault.OnDropData(None, [row(91, const.typePlex, const.groupCurrency, 2), row(92, 34, 18, 7),
                                row(93, const.typePlex, const.groupCurrency, 4),
                                row(None, const.typePlex, const.groupCurrency, 5)])
    finally:
        vault.controller.DepositPlex = original
    return dict(height=vault.height, deposits=deposits)


def training_rows(panel):
    return [dict(text=label.text, expires=expiry.text if expiry.display else None) for label, expiry in
            ((panel.multipleQueueLabel1, panel.multipleQueueExpiryLabel1),
             (panel.multipleQueueLabel2, panel.multipleQueueExpiryLabel2))]


def observe_entitlement_notices(panel):
    subscription = panel.GetOmegaTime()
    queue = sm.GetService('skillqueue')
    get_training = queue.GetMultipleCharacterTraining
    ends = blue.os.GetWallclockTime() + 2 * 864000000000
    try:
        panel.OnSubscriptionTimeUpdateServer(None)
        alpha = [panel.subscriptionHeaderLabel.text, panel.subscriptionDescriptionLabel.text]
        panel.OnSubscriptionTimeUpdateServer(ends)
        omega = [panel.subscriptionHeaderLabel.text, panel.subscriptionDescriptionLabel.text]
        queue.GetMultipleCharacterTraining = lambda *args, **kwargs: {2: ends}
        panel.OnMultipleCharactersTrainingRefreshed()
        return dict(alpha=alpha, omega=omega, training=training_rows(panel))
    finally:
        queue.GetMultipleCharacterTraining = get_training
        panel.LoadPanel()
        panel.OnSubscriptionTimeUpdateServer(subscription)


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
        vault = find_child(panel, Vault)
        return dict(build=3698585, station=session.stationid, panel=PANEL_PLEX, label=GetPanelName(PANEL_PLEX),
                    pointer=tab.uniqueUiName, chain=repr(FindChainForPointer(tab.uniqueUiName)),
                    vaultDrop=observe_vault_drop(vault),
                    balance=actions.controller.balance, cards=[GetByLabel('UI/PlexVault/' + label) for label in
                        ('SellPlexForIsk', 'AddOmegaTime', 'BuyMultipleTraining', 'OpenNewEdenStore', 'BuyPlexForMoney')],
                    cardCount=len(actions.children), headers=[GetByLabel('UI/CharacterSheet/CharacterSheetWindow/PilotLicense/' + label)
                        for label in ('CloneState', 'MultipleCharacterTitle')],
                    clone=dict(text=panel.subscriptionHeaderLabel.text, details=panel.subscriptionDescriptionLabel.text,
                               icon=panel.cloneState.icon.texturePath, time=panel.GetOmegaTime()),
                    slots=dict(sm.GetService('skillqueue').GetMultipleCharacterTraining()),
                    rows=training_rows(panel), entitlementNotices=observe_entitlement_notices(panel))
    finally:
        if opened:
            window._StartLoadingPanel(previous)
            window._UpdateCharacterSheetExpanded(expanded, animate=False)
        else:
            window.Close()
        settings.char.ui.Set('charSheetSelectedPanel', previous)


result = observe()
