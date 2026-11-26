import carbonui.const as uiconst
from eve.client.script.ui.shared.neocom.contracts import contractsearch
from eve.client.script.ui.shared.neocom.contracts.contractsWnd import ContractsWindow
from localization import GetByLabel


def observe():
    window = ContractsWindow.Open()
    panel = window.contractSearchContent
    original_sm = getattr(contractsearch, 'sm', sm)
    had_sm = hasattr(contractsearch, 'sm')
    keys = ('contracts_search_type', 'contracts_search_location', 'contracts_search_customlocations',
            'contracts_search_dropoff', 'contracts_search_dropoff_id')
    missing = object()
    saved = {key: settings.user.ui.Get(key, missing) for key in keys}

    class Captured(Exception):
        pass

    class Proxy(object):
        def SearchContracts(self, **kwargs):
            raise Captured([kwargs['locationID'], kwargs['endLocationID']])

    class Services(object):
        def ProxySvc(self, name):
            return Proxy() if name == 'contractProxy' else original_sm.ProxySvc(name)

        def __getattr__(self, name):
            return getattr(original_sm, name)

    def measure(contract_type):
        try:
            panel.SearchContracts(contractType=contract_type, availability=0)
        except Captured as capture:
            return capture.args[0]
        raise RuntimeError('Search was not captured')

    try:
        contractsearch.sm = Services()
        settings.user.ui.Set('contracts_search_type', 10)
        settings.user.ui.Set('contracts_search_location', 2)
        settings.user.ui.Set('contracts_search_customlocations', [])
        panel.ReconstructLeftFilters()
        panel.advancedCont.state = uiconst.UI_HIDDEN
        observed = {'station': session.stationid, 'options': panel.locationOptions[:6],
                    'default': panel.fltLocation.GetValue(), 'searches': {}}
        for value in (0, 1, 3, 2, 7):
            panel.fltLocation.SelectItemByValue(value)
            observed['searches'][value] = measure(10)
        jita = 30000142
        panel.DoPickLocation(jita)
        observed['searches']['picked'] = measure(10)
        settings.user.ui.Set('contracts_search_type', 3)
        panel.ReconstructLeftFilters()
        panel.advancedCont.state = uiconst.UI_PICKCHILDREN
        panel.fltLocation.SelectItemByValue(7)
        panel.fltDropOffID = jita
        panel.fltDropOff.SetValue(cfg.evelocations.Get(jita).name)
        observed['searches']['courier'] = measure(3)
        panel.advancedCont.state = uiconst.UI_HIDDEN
        observed['searches']['courierCollapsed'] = measure(3)
        observed['location'] = GetByLabel('UI/Common/Location')
        observed['dropoff'] = GetByLabel('UI/Contracts/ContractsSearch/DropOffLocation')
        return observed
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
