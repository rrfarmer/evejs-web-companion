import blue
from carbonui.uicore import uicore
from eve.client.script.ui.shared.neocom.characterSheetWindow import CharacterSheetWindow, charsheet_expanded_setting
from eve.client.script.ui.shared.neocom import charsheet
from eve.client.script.ui.shared.pointerTool.pointerChains import FindChainForPointer
from eve.client.script.ui.shared.pointerTool.pointerToolFunctions import GetScreenElementsByUniqueName
from neocom2.btnIDs import CHARACTER_SHEET_ID
from uihighlighting import uniqueNameConst as names


def observe():
    ids = [names.UNIQUE_NAME_EXPAND_CHARSHEET, names.UNIQUE_NAME_CHARSHEET_CHARACTER_TAB,
           names.UNIQUE_NAME_CHARSHEET_INTERACTION_TAB, names.UNIQUE_NAME_CHARSHEET_HOME_TAB,
           names.UNIQUE_NAME_AUGMENTATIONS_TAB, names.UNIQUE_NAME_JUMP_CLONES_TAB,
           names.UNIQUE_NAME_EXPERT_SYSTEMS_TAB, names.UNIQUE_NAME_DECORATIONS, names.UNIQUE_NAME_TITLES,
           names.UNIQUE_NAME_CHAR_STANDINGS_TAB, names.UNIQUE_NAME_PILOT_SERVICES_TAB,
           names.UNIQUE_NAME_PERSONALIZATION_TAB, names.UNIQUE_NAME_SKINS_TAB, names.UNIQUE_NAME_EMBLEMS_TAB,
           names.UNIQUE_NAME_SECURITY_STATUS_TAB, names.UNIQUE_NAME_COMBAT_LOG_TAB,
           names.UNIQUE_NAME_SHOW_KILLS_LOSSES, names.UNIQUE_NAME_SHOW_KILL_RIGHTS_TAB]
    launcher = names.GetUniqueNeocomPointerName(CHARACTER_SHEET_ID)
    service = sm.GetService('helpPointer')
    catalog = service.GetHighlightByElementName()
    launch_row = service.GetNeocomPointersByElementName()[launcher]
    rows = [dict(name=name, label=catalog[name].label, texture=catalog[name].texturePath,
                 chain=FindChainForPointer(name)) for name in ids if name in catalog]

    def target_for(name):
        node, fallback, _, _, _ = service.FindElementToPointToAndScopeCheck(name)
        return dict(fallback=fallback, node=getattr(node, 'name', None))

    def visible():
        blue.pyos.synchro.SleepWallclock(450)
        return sorted(name for name, element in GetScreenElementsByUniqueName(ids).iteritems()
                      if element and not element.destroyed and element.IsVisible())

    opened = CharacterSheetWindow.GetIfOpen()
    closed_target = target_for(names.UNIQUE_NAME_TITLES) if not opened else None
    if not opened:
        uicore.cmd.OpenCharactersheet()
    window = CharacterSheetWindow.GetIfOpen()
    if not window:
        raise RuntimeError('Character Sheet did not open')
    was_expanded = charsheet_expanded_setting.is_enabled()
    previous = window.GetDefaultPanelID()
    try:
        window._UpdateCharacterSheetExpanded(False, animate=False)
        collapsed = visible()
        collapsed_width = window.width
        collapsed_target = target_for(names.UNIQUE_NAME_TITLES)
        window._UpdateCharacterSheetExpanded(True, animate=False)
        window._StartLoadingPanel(charsheet.PANEL_HOME_STATION, autoExpand=True)
        character = visible()
        expanded_width = window.width
        character_target = target_for(names.UNIQUE_NAME_TITLES)
        window._StartLoadingPanel(charsheet.PANEL_DECORATIONS, autoExpand=True)
        decorations = visible()
        decorations_target = target_for(names.UNIQUE_NAME_TITLES)
        window._StartLoadingPanel(charsheet.PANEL_STANDINGS, autoExpand=True)
        interactions = visible()
        interactions_target = target_for(names.UNIQUE_NAME_TITLES)
    finally:
        if opened:
            window._StartLoadingPanel(previous)
        window._UpdateCharacterSheetExpanded(was_expanded, animate=False)
        if not opened:
            window.Close()
    return dict(station=session.stationid, rows=rows,
                launcher=dict(name=launcher, label=launch_row.label, texture=launch_row.texturePath),
                collapsed=collapsed, character=character, decorations=decorations, interactions=interactions,
                widths=[collapsed_width, expanded_width],
                targets=[closed_target, collapsed_target, character_target, decorations_target, interactions_target])


result = observe()
