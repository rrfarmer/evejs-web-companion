import carbonui.const as uiconst
from eve.client.script.ui.shared.neocom.contracts import contractsearch
from eve.client.script.ui.shared.neocom.contracts.contractsWnd import ContractsWindow
from localization import GetByLabel


def observe():
    window = ContractsWindow.Open()
    panel = window.contractSearchContent
    original_sm = getattr(contractsearch, 'sm', sm)
    had_sm = hasattr(contractsearch, 'sm')
    missing = object()
    keys = ('contracts_search_type', 'contracts_search_category', 'contracts_search_group',
            'contracts_search_typename')
    saved = {key: settings.user.ui.Get(key, missing) for key in keys}

    class Captured(Exception):
        pass

    class Proxy(object):
        def SearchContracts(self, **kwargs):
            raise Captured({'name': kwargs['itemTypeName'], 'ids': sorted(kwargs['itemTypes']) if kwargs['itemTypes'] else []})

    class Services(object):
        def ProxySvc(self, name):
            return Proxy() if name == 'contractProxy' else original_sm.ProxySvc(name)

        def __getattr__(self, name):
            return getattr(original_sm, name)

    def measure(name, exact, visible=True):
        panel.advancedCont.state = uiconst.UI_PICKCHILDREN if visible else uiconst.UI_HIDDEN
        panel.typeName.SetValue(name)
        panel.fltExactType.SetChecked(exact, report=0)
        try:
            panel.SearchContracts(contractType=10, availability=0)
        except Captured as capture:
            return capture.args[0]
        raise RuntimeError('Search was not captured')

    try:
        contractsearch.sm = Services()
        settings.user.ui.Set('contracts_search_type', 10)
        panel.ReconstructLeftFilters()
        panel.ResetTypeFilters()
        return {
            'station': session.stationid,
            'labels': [GetByLabel(label) for label in (
                'UI/Wallet/WalletWindow/ItemType',
                'UI/Contracts/ContractsSearch/labelExactTypeMatch',
            )],
            'partial': measure('Miner I', False),
            'exact': measure('Miner I', True),
            'collapsed': measure('Miner I', True, visible=False),
            'blank': measure('', False),
        }
    finally:
        if had_sm:
            contractsearch.sm = original_sm
        else:
            del contractsearch.sm
        for key, value in saved.items():
            if value is missing:
                settings.user.ui.Delete(key)
            else:
                settings.user.ui.Set(key, value)
        window.Close()


result = observe()
