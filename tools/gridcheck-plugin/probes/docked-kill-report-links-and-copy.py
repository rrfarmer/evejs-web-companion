import blue
from crimewatch.util import GetKillReportHashValue
from eve.client.script.ui.shared import killReportUtil
from eve.client.script.ui.shared.killReport import KillReportWnd


def observe():
    if KillReportWnd.GetIfOpen():
        raise RuntimeError('The reference kill report window is already open')
    recent = sm.RemoteSvc('charMgr').GetRecentShipKillsAndLosses(25, None)
    if not recent:
        raise RuntimeError('The reference pilot has no kill report')
    report = recent[0]
    try:
        window = KillReportWnd.Open(windowID='KillReportWnd', killmail=report)
        for _ in range(60):
            if window.involvedParties.text:
                break
            blue.synchro.SleepWallclock(100)
        else:
            raise RuntimeError('The reference report did not finish loading')
        images = []
        for container in (window.guyCont, window.shipCont):
            sprite = next(each for each in container.children if getattr(each, 'GetDragData', None) == window.GetKillDragData)
            drag = sprite.GetDragData()[0]
            images.append(dict(action=sprite.OnClick[0].__name__, subject=sprite.OnClick[1],
                               drag=drag.__guid__, killID=drag.mail.killID))
        return dict(station=session.stationid, killID=report.killID, images=images,
                    victim=window.victimName.text, ship=window.shipName.text,
                    corporation=window.victimCorpName.text, location=window.locationName.text,
                    attackerCorp=window.finalBlowCont.corpLabel.text, attackerShip=report.finalShipTypeID,
                    attackerWeapon=report.finalWeaponTypeID, settings=[dict(path=row[0].labelPath, label=row[0].GetText())
                                                                      for row in window.GetSettingsMenu()],
                    share=killReportUtil.format_kill_report_url(report.killID, GetKillReportHashValue(report)))
    finally:
        KillReportWnd.CloseIfOpen('KillReportWnd')


result = observe()
