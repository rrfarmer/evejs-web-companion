from eve.client.script.ui.shared.inventory import plexVault
from utillib import KeyVal


def observe():
    cards = []
    routes = []
    actions = plexVault.PlexVaultActions

    class Card(object):
        def __init__(self, **kwargs):
            self.text = kwargs['text']
            self.texture = kwargs['texturePath']
            self.click = kwargs['onClick']
            self.highlight = kwargs.get('isHighlighted', False)
            self.price = kwargs.get('price')
            kwargs['parent'].children.append(self)
            self.enabled = True

        def ResetSize(self):
            pass

        def Enable(self):
            self.enabled = True

        def Disable(self):
            self.enabled = False

    class Services(object):
        def GetService(self, name):
            return self

        def OpenStore(self, **kwargs):
            routes.append(kwargs)

    class VaultActions(object):
        children = cards
        controller = KeyVal(balance=0, SellPlex=lambda: routes.append('sell'))
        logContext = 'inventory-vault-probe'

        def UnifyContentSize(self):
            pass

        def UpdatePlexActionHeights(self):
            pass

    for method in ('SellPlex', 'BuyOmegaTime', 'BuyMultipleTraining', 'OpenNewEdenStore', 'BuyPlex', 'OnBalanceUpdated'):
        setattr(VaultActions, method, getattr(actions, method).__func__)
    target = VaultActions()
    probes = [(plexVault, 'PlexAction', Card),
              (plexVault, 'sm', Services()),
              (plexVault, 'uicore', KeyVal(cmd=KeyVal(ToggleAurumStore=lambda: routes.append('store'),
                                                    CmdBuyPlex=lambda context: routes.append(['buy', context]))))]
    missing = object()
    originals = [(module, key, vars(module).get(key, missing)) for module, key, value in probes]
    try:
        for module, key, value in probes:
            setattr(module, key, value)
        actions.Load.__func__(target)
        empty_enabled = [card.enabled for card in cards]
        target.OnBalanceUpdated(1)
        for card in cards:
            card.click()
        return dict(station=session.stationid, routes=routes, emptyEnabled=empty_enabled,
                    fundedEnabled=[card.enabled for card in cards], labels=[card.text for card in cards],
                    icons=[card.texture for card in cards], highlighted=[card.highlight for card in cards],
                    priceType=plexVault.invconst.typeMultiTrainingToken if cards[2].price else None)
    finally:
        for module, key, value in originals:
            if value is missing:
                delattr(module, key)
            else:
                setattr(module, key, value)


result = observe()
