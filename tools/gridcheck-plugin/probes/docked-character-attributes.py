import blue
from carbonui.uicore import uicore
from eve.client.script.ui.shared.neocom.attributes import AttributeRespecWindow
from eve.client.script.ui.shared.neocom.characterSheetWindow import CharacterSheetWindow, charsheet_expanded_setting
from eve.client.script.ui.shared.neocom.charsheet import PANEL_ATTRIBUTES, GetPanelName, GetPanelUniqueName
from eve.common.lib import appConst as const


def observe():
    if AttributeRespecWindow.GetIfOpen():
        raise RuntimeError('Neural Remapping is already open')
    opened = CharacterSheetWindow.GetIfOpen()
    if not opened:
        uicore.cmd.OpenCharactersheet()
    window = CharacterSheetWindow.GetIfOpen()
    expanded = charsheet_expanded_setting.is_enabled()
    previous = window.GetDefaultPanelID()
    try:
        window._UpdateCharacterSheetExpanded(True, animate=False)
        window._StartLoadingPanel(PANEL_ATTRIBUTES, autoExpand=True)
        for _ in range(80):
            panel = getattr(window.characterPanel, 'attributesPanel', None)
            entry = getattr(panel, 'respecEntry', None) if panel else None
            if entry and entry.panel:
                break
            blue.synchro.SleepWallclock(100)
        else:
            raise RuntimeError('Character Attributes rows did not load')
        rows = [dict(id=node.attributeID, label=node.label, text=node.text, icon=node.iconID, typeID=node.typeID)
                for node in panel.scroll.GetNodes() if node is not entry]
        remap = entry.panel.sr
        entry.panel.OpenRespecWindow(remap.respecButton.args[0])
        wnd = AttributeRespecWindow.GetIfOpen()
        if wnd is None:
            raise RuntimeError('Neural Remapping did not open')
        return dict(station=session.stationid, panel=PANEL_ATTRIBUTES, caption=GetPanelName(PANEL_ATTRIBUTES),
                    pointer=GetPanelUniqueName(PANEL_ATTRIBUTES), rows=rows, label=remap.label.text,
                    nextRemap=remap.respecTime.text, bonus=remap.numberOfRemaps.text,
                    button=remap.respecButton.label, readOnly=wnd.readOnly, minimum=const.respecMinimumAttributeValue,
                    maximum=const.respecMaximumAttributeValue, total=const.respecTotalRespecPoints,
                    overview=dict(id=wnd.windowID, caption=wnd.caption, attributes=wnd.currentAttributes,
                                  implants=wnd.implantModifier, unspent=wnd.unspentPts))
    finally:
        AttributeRespecWindow.CloseIfOpen()
        if opened:
            window._StartLoadingPanel(previous)
            window._UpdateCharacterSheetExpanded(expanded, animate=False)
        else:
            window.Close()


result = observe()
