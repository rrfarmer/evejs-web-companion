import carbonui.const as uiconst
from eve.client.script.ui.shared.neocom.contracts import contractsearch
from eve.client.script.ui.shared.neocom.contracts.contractsWnd import ContractsWindow
from localization import GetByLabel


def observe():
    window = ContractsWindow.Open()
    panel = window.contractSearchContent
    original_sm = getattr(contractsearch, 'sm', sm)
    had_sm = hasattr(contractsearch, 'sm')
    saved = {
        key: settings.user.ui.Get(key, None)
        for key in ('contracts_search_minprice', 'contracts_search_maxprice',
                    'contracts_search_type', 'contracts_search_dropoff',
                    'contracts_search_dropoff_id', 'contracts_search_minreward',
                    'contracts_search_maxreward', 'contracts_search_mincollateral',
                    'contracts_search_maxcollateral', 'contracts_search_minvolume',
                    'contracts_search_maxvolume')
    }

    class Captured(Exception):
        pass

    class Proxy(object):
        def SearchContracts(self, **kwargs):
            raise Captured(kwargs['securityClasses'])

    class Services(object):
        def ProxySvc(self, name):
            return Proxy() if name == 'contractProxy' else original_sm.ProxySvc(name)

        def __getattr__(self, name):
            return getattr(original_sm, name)

    def measure(visible, high, low, null, contract_type=10):
        panel.advancedCont.state = uiconst.UI_PICKCHILDREN if visible else uiconst.UI_HIDDEN
        panel.fltSecHigh.SetChecked(high, report=0)
        panel.fltSecLow.SetChecked(low, report=0)
        panel.fltSecNull.SetChecked(null, report=0)
        try:
            panel.SearchContracts(contractType=contract_type, availability=0)
        except Captured as capture:
            return capture.args[0]
        raise RuntimeError('Search was not captured')

    try:
        contractsearch.sm = Services()
        settings.user.ui.Set('contracts_search_type', 10)
        panel.ReconstructLeftFilters()
        observed = {
            'station': session.stationid,
            'labels': [GetByLabel(label) for label in (
                'UI/Contracts/ContractsSearch/SecurityFilters',
                'UI/Common/HighSecurityShort', 'UI/Common/LowSecurityShort', 'UI/Common/NullSecurityShort',
                'UI/Common/HighSec', 'UI/Common/LowSec', 'UI/Common/NullSec',
            )],
            'all': measure(True, True, True, True),
            'none': measure(True, False, False, False),
            'high': measure(True, True, False, False),
            'low': measure(True, False, True, False),
            'null': measure(True, False, False, True),
            'lowNull': measure(True, False, True, True),
            'collapsed': measure(False, True, False, False),
        }
        settings.user.ui.Set('contracts_search_type', 3)
        panel.ReconstructLeftFilters()
        observed['courier'] = measure(True, False, True, False, contract_type=3)
        return observed
    finally:
        if had_sm:
            contractsearch.sm = original_sm
        else:
            del contractsearch.sm
        for key, value in saved.items():
            settings.user.ui.Set(key, value)
        window.Close()


result = observe()
