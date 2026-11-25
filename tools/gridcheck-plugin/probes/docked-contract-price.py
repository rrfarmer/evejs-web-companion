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
        for key in ('contracts_search_minprice', 'contracts_search_maxprice')
    }

    class Captured(Exception):
        pass

    class Proxy(object):
        def SearchContracts(self, **kwargs):
            raise Captured([kwargs['minPrice'], kwargs['maxPrice']])

    class Services(object):
        def ProxySvc(self, name):
            return Proxy() if name == 'contractProxy' else original_sm.ProxySvc(name)

        def __getattr__(self, name):
            return getattr(original_sm, name)

    def measure(visible, enabled, minimum, maximum):
        panel.advancedCont.state = uiconst.UI_PICKCHILDREN if visible else uiconst.UI_HIDDEN
        panel.fltCbPrice.SetChecked(enabled, report=0)
        panel.fltMinPrice.SetValue(minimum)
        panel.fltMaxPrice.SetValue(maximum)
        try:
            panel.SearchContracts(contractType=10, availability=0)
        except Captured as capture:
            return capture.args[0]
        raise RuntimeError('Search was not captured')

    try:
        contractsearch.sm = Services()
        return {
            'station': session.stationid,
            'labels': [GetByLabel(label) for label in (
                'UI/Contracts/ContractsSearch/buttonShowMoreOptions',
                'UI/Contracts/ContractsSearch/buttonShowLessOptions',
                'UI/Contracts/ContractsSearch/labelPriceMillions',
                'UI/Contracts/ContractsSearch/hintMin',
                'UI/Common/ToNumber',
                'UI/Contracts/ContractsSearch/hintMax',
            )],
            'enabled': measure(True, True, 2, 5),
            'unchecked': measure(True, False, 2, 5),
            'collapsed': measure(False, True, 2, 5),
            'upperOnly': measure(True, True, 0, 5),
        }
    finally:
        if had_sm:
            contractsearch.sm = original_sm
        else:
            del contractsearch.sm
        for key, value in saved.items():
            settings.user.ui.Set(key, value)
        window.Close()


result = observe()
