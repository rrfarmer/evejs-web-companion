import blue
from cosmetics.client.cosmeticsSvc import FirstPartySkin
from carbonui.uicore import uicore
from eve.client.script.ui.shared.neocom.characterSheetWindow import CharacterSheetWindow, charsheet_expanded_setting
from eve.client.script.ui.shared.neocom.charsheet import PANEL_PERSONALIZATION, PANEL_SHIPSKINS, GetPanelName, GetPanelUniqueName
from eve.client.script.ui.shared.pointerTool.pointerChains import FindChainForPointer
from localization import GetByLabel


class SettingsMenu(object):
    def __init__(self):
        self.options = []

    def AddRadioButton(self, **attrs):
        self.options.append([attrs['text'], attrs['checked']])


def observe_durations():
    static = sm.GetService('cosmeticsSvc').static
    skin = static.GetSkinByID(3288)
    material = static.GetMaterialByID(skin.skinMaterialID)
    now = blue.os.GetWallclockTime()
    minute = 600000000
    later = now + (2 * 24 * 60 + 3 * 60 + 4) * minute + minute // 2
    soon = now + minute // 2
    past = now - minute
    cases = (('permanent', None, False), ('limited', later, False), ('singleUse', None, True),
             ('timedSingleUse', later, True), ('lastMinute', soon, True), ('expired', past, False),
             ('expiredSingleUse', past, True), ('unlicensed', None, False))
    return dict(prefix=GetByLabel('Achievements/UI/active'), labels=dict((name,
        FirstPartySkin(material, skin=skin, licensed=name != 'unlicensed', expires=expires,
                       isSingleUse=single_use).GetExpiresLabel()) for name, expires, single_use in cases))


def observe():
    opened = CharacterSheetWindow.GetIfOpen()
    if not opened:
        uicore.cmd.OpenCharactersheet()
    window = CharacterSheetWindow.GetIfOpen()
    previous = window.GetDefaultPanelID()
    expanded = charsheet_expanded_setting.is_enabled()
    try:
        window._UpdateCharacterSheetExpanded(True, animate=False)
        window._StartLoadingPanel(PANEL_PERSONALIZATION, autoExpand=True)
        parent = window.personalizationPanel
        for _ in range(120):
            if parent.display and getattr(parent, 'skinsPanel', None):
                break
            blue.synchro.SleepWallclock(100)
        parent.LoadSubPanel(PANEL_SHIPSKINS)
        panel = parent.skinsPanel
        panel.LoadPanel()
        options = SettingsMenu()
        panel.GetSettingsMenu(options)
        groups = panel.scroll.GetNodes()
        pointer = GetPanelUniqueName(PANEL_SHIPSKINS)
        parent_tab = window.mainTabGroup.GetTabByID(PANEL_PERSONALIZATION)
        return dict(build=3698585, station=session.stationid, tabs=[GetPanelName(PANEL_PERSONALIZATION), GetPanelName(PANEL_SHIPSKINS)],
                    pointer=pointer, parent=parent_tab.uniqueUiName, chain=repr(FindChainForPointer(pointer)),
                    counter=panel.counterText.text, options=options.options, groupCount=len(groups), durations=observe_durations(),
                    sample=[dict(label=row.label, children=[child.label for child in panel._GetSkinsSubContent(row)][:4]) for row in groups[:6]])
    finally:
        if opened:
            window._StartLoadingPanel(previous)
            window._UpdateCharacterSheetExpanded(expanded, animate=False)
        else:
            window.Close()
        settings.char.ui.Set('charSheetSelectedPanel', previous)


result = observe()
