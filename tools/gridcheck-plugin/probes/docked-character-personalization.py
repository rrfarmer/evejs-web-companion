import blue
from cosmetics.client.cosmeticsSvc import FirstPartySkin
from carbonui import uiconst
from carbonui.uicore import uicore
from carbonui.util.bunch import Bunch
from eve.client.script.ui.services.menuSvcExtras import menuFunctions
from eve.client.script.ui.shared.neocom.characterSheetWindow import CharacterSheetWindow, charsheet_expanded_setting
from eve.client.script.ui.shared.neocom.charsheet import PANEL_PERSONALIZATION, PANEL_SHIPSKINS, PANEL_SHIPEMBLEMS, GetPanelName, GetPanelUniqueName
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


def observe_license_drops(panel):
    service = sm.GetService('cosmeticsSvc')
    original_prompt = menuFunctions.prompt_player_fsd_dialog
    original_activate = service.ActivateShipSkinLicense
    calls, prompts = [], []
    answer = [uiconst.ID_NO]

    def prompt(key, values, *args, **kwargs):
        prompts.append(dict(key=key, values=values, suppress=kwargs.get('suppress') == uiconst.ID_YES))
        return answer[0]

    def row(item_id, type_id, category=91, guid='listentry.InvItem'):
        return Bunch(__guid__=guid, rec=Bunch(itemID=item_id, typeID=type_id, categoryID=category))

    try:
        menuFunctions.prompt_player_fsd_dialog = prompt
        service.ActivateShipSkinLicense = lambda ids: calls.append(ids)
        permanent = row(1, 42671)
        limited = row(2, 34779, guid='listentry.InvAssetItem')
        volatile = row(3, 46585)
        mineral = row(4, 34, category=4)
        panel.OnDropData(None, [mineral])
        panel.OnDropData(None, [permanent])
        answer[0] = uiconst.ID_YES
        panel.OnDropData(None, [limited])
        panel.OnDropData(None, [volatile])
        panel.OnDropData(None, [permanent, mineral, limited])
        return dict(prompts=prompts, calls=calls)
    finally:
        menuFunctions.prompt_player_fsd_dialog = original_prompt
        service.ActivateShipSkinLicense = original_activate


def observe_emblems(parent):
    parent.LoadSubPanel(PANEL_SHIPEMBLEMS)
    panel = parent.emblemsPanel
    panel.LoadPanel()
    options = SettingsMenu()
    panel.GetSettingsMenu(options)
    pointer = GetPanelUniqueName(PANEL_SHIPEMBLEMS)
    groups = panel.scroll.GetNodes()
    return dict(tab=GetPanelName(PANEL_SHIPEMBLEMS), pointer=pointer, chain=repr(FindChainForPointer(pointer)), options=options.options,
                counter=panel.counterText.text, groups=[dict(label=row.label, count=len(row.groupItems),
                    hulls=[child.label for child in panel._GetEmblemSubContent(row)][:5]) for row in groups])


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
                    licenseDrops=observe_license_drops(panel), emblems=observe_emblems(parent),
                    sample=[dict(label=row.label, children=[child.label for child in panel._GetSkinsSubContent(row)][:4]) for row in groups[:6]])
    finally:
        if opened:
            window._StartLoadingPanel(previous)
            window._UpdateCharacterSheetExpanded(expanded, animate=False)
        else:
            window.Close()
        settings.char.ui.Set('charSheetSelectedPanel', previous)


result = observe()
