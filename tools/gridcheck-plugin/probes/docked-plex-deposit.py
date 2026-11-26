from eve.client.script.ui.services.menuSvcExtras import menuFunctions
from eve.client.script.ui.shared.inventory import plexVault
from inventorycommon import const
from localization import GetByLabel
from utillib import KeyVal


def observe():
    calls = []

    class Services(object):
        def GetService(self, name):
            return self

        def GetInventoryMgr(self):
            return self

        def DepositPlexToVault(self, *args):
            calls.append(list(args))
            return 'probe-deposit'

    def listener(user, amount, reference):
        calls.append([amount, reference])

    patches = [(plexVault, 'sm', Services()), (menuFunctions, 'sm', Services()),
               (plexVault, 'PlexDepositListener', listener)]
    missing = object()
    original = [(module, key, vars(module).get(key, missing)) for module, key, value in patches]
    try:
        for module, key, value in patches:
            setattr(module, key, value)
        first = KeyVal(itemID=70001, typeID=const.typePlex, groupID=const.groupCurrency, stacksize=3)
        other = KeyVal(itemID=70002, typeID=34, groupID=18, stacksize=7)
        second = KeyVal(itemID=70003, typeID=const.typePlex, groupID=const.groupCurrency, stacksize=2)
        plexVault.PlexVaultController().OnDropData(None, [KeyVal(item=item) for item in [first, other, second]] + [KeyVal()])
        menuFunctions.RedeemCurrency(first, first.stacksize)
        return dict(station=session.stationid, label=GetByLabel('UI/Inventory/ItemActions/RedeemCurrency'), calls=calls)
    finally:
        for module, key, value in original:
            if value is missing:
                delattr(module, key)
            else:
                setattr(module, key, value)


result = observe()
