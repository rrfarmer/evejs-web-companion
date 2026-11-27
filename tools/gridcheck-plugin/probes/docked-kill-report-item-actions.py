import blue
from carbonui.control.contextMenu.menuDataFactory import CreateMenuDataFromRawTuples
from eve.client.script.ui.shared.killReport import KillItems, KillReportWnd
from evelink import client as evelink


def observe():
    if KillReportWnd.GetIfOpen():
        raise RuntimeError('The reference kill report window is already open')
    recent = sm.RemoteSvc('charMgr').GetRecentShipKillsAndLosses(25, None)
    if not recent:
        raise RuntimeError('The reference pilot has no kill report')
    try:
        window = KillReportWnd.Open(windowID='KillReportWnd', killmail=recent[0])
        for _ in range(60):
            nodes = [node for node in window.itemsScroll.GetNodes() if node.get('typeID') and node.panel]
            if any(node.typeID == 34 for node in nodes):
                break
            blue.synchro.SleepWallclock(100)
        else:
            raise RuntimeError('The reference item rows did not finish loading')
        rows = []
        for node in nodes:
            data = node.panel.GetDragData()[0]
            link = evelink.type_link(data.typeID, getattr(data, 'itemID', None))
            entries = CreateMenuDataFromRawTuples(node.panel.GetMenu()).GetEntries()
            rows.append(dict(typeID=node.typeID, dragGuid=data.__guid__, dragID=data.typeID,
                             url=link.url, text=link.text, copy=KillItems.GetCopyData(node),
                             menu=[dict(path=entry.GetLabelPath(), label=entry.GetTextDescriptive())
                                   for entry in entries if entry is not None]))
        return dict(station=session.stationid, killID=recent[0].killID, rows=rows)
    finally:
        KillReportWnd.CloseIfOpen('KillReportWnd')


result = observe()
