import carbonui.const as uiconst
import evetypes
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
            raise Captured([kwargs['itemCategoryID'], kwargs['itemGroupID'], kwargs['searchHint']])

    class Services(object):
        def ProxySvc(self, name):
            return Proxy() if name == 'contractProxy' else original_sm.ProxySvc(name)

        def __getattr__(self, name):
            return getattr(original_sm, name)

    def measure(category, group=None, visible=True):
        panel.advancedCont.state = uiconst.UI_PICKCHILDREN if visible else uiconst.UI_HIDDEN
        panel.fltCategories.SelectItemByValue(category)
        panel.PopulateGroupCombo()
        if group:
            panel.fltGroups.SelectItemByValue(group)
        try:
            panel.SearchContracts(contractType=10, availability=0)
        except Captured as capture:
            return capture.args[0]
        raise RuntimeError('Search was not captured')

    try:
        contractsearch.sm = Services()
        settings.user.ui.Set('contracts_search_type', 10)
        panel.ReconstructLeftFilters()
        panel.typeName.SetValue('')
        groups = [(evetypes.GetGroupNameByGroup(group), group)
                  for group in evetypes.GetGroupIDsByCategory(6)
                  if evetypes.IsGroupPublishedByGroup(group)]
        return {
            'station': session.stationid,
            'labels': [GetByLabel(label) for label in (
                'UI/Contracts/ContractsSearch/ContractCategory',
                'UI/Contracts/ContractsSearch/contractroup',
                'UI/Contracts/ContractsSearch/comboAll',
            )],
            'categories': panel.GetContractCategoryOptions(),
            'shipGroups': sorted(groups, key=lambda value: value[0].lower()),
            'all': measure(None),
            'ship': measure((6, 0)),
            'frigate': measure((6, 0), 25),
            'original': measure((9, 1)),
            'copy': measure((9, 2)),
            'collapsed': measure((6, 0), 25, visible=False),
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
