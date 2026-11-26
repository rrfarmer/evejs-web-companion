from eve.client.script.ui.shared.inventory import plexVault
from eve.client.script.ui.shared.market import sellMulti
from eve.client.script.ui.shared.neocom.wallet.panels.personal.plex import vault_actions
from localization import GetByLabel
from utillib import KeyVal


def observe():
    rows = []

    class Services(object):
        def GetService(self, name):
            return self

        def GetInventoryMgr(self):
            return self

        def WithdrawPlexFromVault(self, *args):
            rows.append(list(args))
            return 'probe-reference'

    class Wheel(object):
        def __init__(self, **kwargs):
            pass

        def Show(self):
            pass

        def Hide(self):
            pass

    def listener(user, quantity, reference):
        rows.append([quantity, reference])
        return KeyVal(received_event=True, received_item_id=8765432)

    selected = []
    patches = [(plexVault, 'SellItems', lambda items: selected.extend(items)),
               (sellMulti, 'sm', Services()), (sellMulti, 'LoadingWheel', Wheel),
               (sellMulti, 'PlexWithdrawalListener', listener)]
    missing = object()
    original = [(module, key, vars(module).get(key, missing)) for module, key, value in patches]
    try:
        for module, key, value in patches:
            setattr(module, key, value)
        controller = plexVault.PlexVaultController()
        vault_actions.SellPLEXButton.OnClick.__func__(KeyVal(is_plex_available=False, controller=controller))
        disabled_count = len(selected)
        vault_actions.SellPLEXButton.OnClick.__func__(KeyVal(is_plex_available=True, controller=controller))
        item = selected[0]
        row = KeyVal(typeID=item.typeID, locationID=item.locationID, itemID=None, item=item, GetQtyToSell=lambda: 3)
        sellMulti.SellItems.CheckAndHandlePlexVaultItem.__func__(KeyVal(mainCont=None), row)
        return dict(station=session.stationid, balance=item.quantity, typeID=item.typeID,
                    label=vault_actions.SellPLEXButton.LABEL_TEXT,
                    disabledHint=GetByLabel('UI/PlexVault/SellPlexForIskDisabledTooltipDescription'),
                    disabledCount=disabled_count, location=item.locationID, flag=item.flagID,
                    calls=rows, withdrawnItem=row.itemID)
    finally:
        for module, key, value in original:
            if value is missing:
                delattr(module, key)
            else:
                setattr(module, key, value)


result = observe()
