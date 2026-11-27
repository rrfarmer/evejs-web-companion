import blue
from eve.client.script.ui.shared.killReport import KillReportWnd


def observe():
    window_id = 'KillReportWnd'
    if KillReportWnd.GetIfOpen(window_id):
        raise RuntimeError('The reference report window is already open')
    recent = sm.RemoteSvc('charMgr').GetRecentShipKillsAndLosses(25, None)
    if not recent:
        raise RuntimeError('The reference pilot has no kill report')
    kill = recent[0]
    try:
        window = KillReportWnd.Open(windowID=window_id, killmail=kill)
        for _ in range(60):
            if window.involvedParties.text:
                break
            blue.synchro.SleepWallclock(100)
        if not window.involvedParties.text:
            raise RuntimeError('Kill report did not finish loading')
        entries = []
        for node in window.itemsScroll.GetNodes():
            if node.get('typeID'):
                entries.append(dict(typeID=node.typeID, dropped=node.qtyDropped, destroyed=node.qtyDestroyed,
                                    indented=bool(node.indented)))
            else:
                entries.append(dict(heading=node.label, icon=node.iconID))
        return dict(station=session.stationid, killID=kill.killID,
                    minimum=list(window.default_minSize), victim=window.victimName.text,
                    ship=window.shipName.text, location=window.locationName.text,
                    involved=window.involvedParties.text, damage=window.damageTaken.text,
                    final=window.finalBlowCont.nameLabel.text, top=window.topDamageCont.nameLabel.text,
                    others=len(window.killersScroll.GetNodes()), items=entries, worth=window.totalWorthLabel.text,
                    payout=bool(window.totalPayoutCont.display))
    finally:
        KillReportWnd.CloseIfOpen(window_id)


result = observe()
