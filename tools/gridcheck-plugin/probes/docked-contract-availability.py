import carbonui.const as uiconst
from eve.client.script.ui.shared.neocom.contracts import contractsearch
from eve.client.script.ui.shared.neocom.contracts.contractsWnd import ContractsWindow
from localization import GetByLabel


def observe():
    window = ContractsWindow.Open()
    panel = window.contractSearchContent
    original_sm = getattr(contractsearch, 'sm', sm)
    had_sm = hasattr(contractsearch, 'sm')
    original_session = getattr(contractsearch, 'session', session)
    had_session = hasattr(contractsearch, 'session')
    missing = object()
    keys = ('contracts_search_type', 'contracts_search_avail', 'contracts_search_category',
            'contracts_search_group', 'contracts_search_typename', 'contracts_search_dropoff', 'contracts_search_dropoff_id',
            'contracts_search_minreward', 'contracts_search_maxreward', 'contracts_search_mincollateral',
            'contracts_search_maxcollateral', 'contracts_search_minvolume', 'contracts_search_maxvolume')
    saved = {key: settings.user.ui.Get(key, missing) for key in keys}

    class Captured(Exception):
        pass

    class Proxy(object):
        def SearchContracts(self, **kwargs):
            raise Captured(kwargs['availability'])

    class Services(object):
        def ProxySvc(self, name):
            return Proxy() if name == 'contractProxy' else original_sm.ProxySvc(name)

        def __getattr__(self, name):
            return getattr(original_sm, name)

    class Membership(object):
        def __init__(self, corporation, alliance):
            self.corpid = corporation
            self.allianceid = alliance

        def __getattr__(self, name):
            return getattr(original_session, name)

    def measure(selection, visible=True, contract_type=10):
        panel.advancedCont.state = uiconst.UI_PICKCHILDREN if visible else uiconst.UI_HIDDEN
        panel.fltAvail.SelectItemByValue(selection)
        try:
            panel.SearchContracts(contractType=contract_type)
        except Captured as capture:
            return capture.args[0]
        raise RuntimeError('Search was not captured')

    try:
        contractsearch.sm = Services()
        settings.user.ui.Set('contracts_search_type', 10)
        settings.user.ui.Set('contracts_search_avail', 0)
        panel.ReconstructLeftFilters()
        panel.ResetTypeFilters()
        contractsearch.session = Membership(1000044, None)
        npc_options = panel.GetAvailabilityOptions()
        contractsearch.session = Membership(98000001, None)
        corp_options = panel.GetAvailabilityOptions()
        contractsearch.session = Membership(98000001, 99000001)
        alliance_options = panel.GetAvailabilityOptions()
        panel.ReconstructLeftFilters()
        panel.ResetTypeFilters()
        result = {
            'station': session.stationid,
            'label': GetByLabel('UI/Contracts/ContractsSearch/Availability'),
            'npc': npc_options, 'corporation': corp_options, 'alliance': alliance_options,
            'public': measure(0), 'personal': measure(1), 'corp': measure(2), 'ally': measure(3),
            'collapsed': measure(3, visible=False),
        }
        settings.user.ui.Set('contracts_search_type', 3)
        panel.ReconstructLeftFilters()
        result['courier'] = measure(1, contract_type=3)
        return result
    finally:
        if had_session:
            contractsearch.session = original_session
        else:
            del contractsearch.session
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
