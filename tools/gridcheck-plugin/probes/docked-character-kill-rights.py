import blue
import utillib
from carbonui.uicore import uicore
from eve.client.script.ui.shared.killRights import SellKillRightWnd
from eve.client.script.ui.shared.neocom.characterSheetWindow import CharacterSheetWindow, charsheet_expanded_setting
from eve.client.script.ui.shared.neocom.charsheet import PANEL_INTERACTIONS, PANEL_KILLRIGHTS, GetPanelName, GetPanelUniqueName
from eve.client.script.ui.shared.pointerTool.pointerChains import FindChainForPointer


class Actions(object):
    def __init__(self):
        self.labels = []

    def AddIconEntry(self, **kwargs):
        self.labels.append(kwargs['text'])


def observe():
    if SellKillRightWnd.GetIfOpen():
        raise RuntimeError('Sell Kill Right is already open')
    opened = CharacterSheetWindow.GetIfOpen()
    if not opened:
        uicore.cmd.OpenCharactersheet()
    window = CharacterSheetWindow.GetIfOpen()
    expanded = charsheet_expanded_setting.is_enabled()
    previous = window.GetDefaultPanelID()
    bounty = sm.GetService('bountySvc')
    original = bounty.myKillRights
    try:
        window._UpdateCharacterSheetExpanded(True, animate=False)
        window._StartLoadingPanel(PANEL_INTERACTIONS, autoExpand=True)
        window.interactionsPanel.LoadSubPanel(PANEL_KILLRIGHTS)
        for _ in range(80):
            panel = getattr(window.interactionsPanel, 'killRightsPanel', None)
            if panel and panel.display:
                break
            blue.synchro.SleepWallclock(100)
        else:
            raise RuntimeError('Kill Rights panel did not load')
        original_count = len(panel.scroll.GetNodes())
        now = blue.os.GetWallclockTime()
        def right(id_, source, target, expires, price=None):
            return utillib.KeyVal(killRightID=id_, fromID=source, toID=target, expiryTime=expires,
                                  price=price, restrictedTo=None)
        bounty.myKillRights = [right(9101, session.charid, 140000001, now + 864000000000),
                               right(9102, session.charid, 140000002, now + 864000000000, 0),
                               right(9103, 140000002, session.charid, now + 864000000000, 12500),
                               right(9104, session.charid, 140000001, now - 1)]
        panel.LoadPanel()
        blue.synchro.SleepWallclock(350)
        nodes = panel.scroll.GetNodes()
        rows = []
        for node in nodes:
            if not node.Get('killRight', None):
                continue
            controls = Actions()
            if node.isMine:
                node.panel.SellKillRight(controls)
            rows.append(dict(id=node.killRight.killRightID, mine=node.isMine, price=node.killRight.price,
                             actions=controls.labels, available=node.panel.availableLabel.text,
                             sale=node.panel.saleLabel.text, menuVisible=node.panel.utilMenuCont.display))
        entry_panel = next(node.panel for node in nodes if node.Get('killRight', None) and node.killRight.killRightID == 9101)
        badges = []
        for watched, online in ((False, True), (True, True), (True, False), (True, None)):
            entry_panel.inWatchlist = watched
            entry_panel.SetOnline(online)
            badges.append(dict(watched=watched, online=online, visible=entry_panel.statusIcon.display,
                                hint=entry_panel.statusIcon.hint if entry_panel.statusIcon.display else None))
        owner_menu = [each.GetText() if hasattr(each, 'GetText') else unicode(each[0])
                      for each in entry_panel.GetMenu() if hasattr(each, 'GetText') or isinstance(each, tuple)]
        pointer = GetPanelUniqueName(PANEL_KILLRIGHTS)
        entry = sm.GetService('helpPointer').GetHighlightByElementName()[pointer]
        return dict(station=session.stationid, caption=GetPanelName(PANEL_KILLRIGHTS), originalCount=original_count,
                    pointer=dict(id=pointer, chain=FindChainForPointer(pointer), label=entry.label, texture=entry.texturePath),
                    headings=[node.label for node in nodes if not node.Get('killRight', None)], rows=rows,
                    badges=badges, ownerMenu=owner_menu, projected=True)
    finally:
        bounty.myKillRights = original
        if opened:
            window._StartLoadingPanel(previous)
            window._UpdateCharacterSheetExpanded(expanded, animate=False)
        else:
            window.Close()


result = observe()
