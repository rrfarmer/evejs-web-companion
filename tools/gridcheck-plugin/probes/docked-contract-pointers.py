import blue
from carbonui.uicore import uicore
from eve.client.script.ui.shared.neocom.contracts.contractsWnd import ContractsWindow
from eve.client.script.ui.shared.pointerTool.pointerChains import FindChainForPointer
from eve.client.script.ui.shared.pointerTool.pointerToolFunctions import GetScreenElementsByUniqueName
from neocom2.btnIDs import CONTRACTS_ID
from uihighlighting import uniqueNameConst as names


def visible_pointers(ids):
    blue.pyos.synchro.SleepWallclock(250)
    return sorted(name for name, element in GetScreenElementsByUniqueName(ids).iteritems()
                  if element and not element.destroyed and element.IsVisible())


def observe():
    ids = [names.UNIQUE_NAME_AVAILABLE_CONTRACTS_TAB, names.UNIQUE_NAME_SHOW_CONTRACT_OPTIONS,
           names.UNIQUE_NAME_CONTRACT_AVAILABILITY_SETTINGS]
    launcher = names.GetUniqueNeocomPointerName(CONTRACTS_ID)
    service = sm.GetService('helpPointer')
    catalog = service.GetHighlightByElementName()
    launch_row = service.GetNeocomPointersByElementName()[launcher]
    rows = [dict(name=name, label=catalog[name].label, texture=catalog[name].texturePath,
                 chain=FindChainForPointer(name)) for name in ids]

    def target_for(name):
        node, fallback, _, _, _ = service.FindElementToPointToAndScopeCheck(name)
        return dict(fallback=fallback, node=getattr(node, 'name', None))

    opened = ContractsWindow.GetIfOpen()
    closed_target = target_for(ids[-1]) if not opened else None
    if not opened:
        uicore.cmd.OpenContracts()
    window = ContractsWindow.GetIfOpen()
    if not window:
        raise RuntimeError('Contracts window did not open')
    selected = window.tabGroup.GetSelectedID()
    panel = window.contractSearchContent
    try:
        window.tabGroup.SelectByIdx(0)
        home = visible_pointers(ids)
        home_target = target_for(ids[-1])
        window.tabGroup.SelectByIdx(2)
        toggle = panel.advancedDivider
        was_expanded = bool(settings.user.ui.Get('contracts_search_expander_advanced', 0))
        try:
            if was_expanded:
                panel.ToggleAdvanced(toggle, force=False)
            collapsed = visible_pointers(ids)
            collapsed_text = toggle.label.text
            collapsed_target = target_for(ids[-1])
            panel.ToggleAdvanced(toggle, force=True)
            expanded = visible_pointers(ids)
            expanded_text = toggle.label.text
            expanded_target = target_for(ids[-1])
            options = [value[0] for value in panel.GetAvailabilityOptions()]
        finally:
            if not was_expanded:
                panel.ToggleAdvanced(toggle, force=False)
    finally:
        if not opened:
            window.Close()
        else:
            window.tabGroup.SelectByID(selected)
    return dict(station=session.stationid, rows=rows,
                launcher=dict(name=launcher, label=launch_row.label, texture=launch_row.texturePath),
                home=home, collapsed=collapsed, expanded=expanded,
                targets=[closed_target, home_target, collapsed_target, expanded_target],
                disclosure=[collapsed_text, expanded_text], options=options)


result = observe()
