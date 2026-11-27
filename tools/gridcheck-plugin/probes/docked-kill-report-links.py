import blue
from crimewatch.util import GetKillReportHashValue
from eve.client.script.ui.shared import killReportUtil
from eve.client.script.ui.shared.killReport import KillReportWnd


def observe():
    recent = sm.RemoteSvc('charMgr').GetRecentShipKillsAndLosses(25, None)
    if not recent:
        raise RuntimeError('The reference pilot has no kill report')
    kill = recent[0]
    url = killReportUtil.format_kill_report_url(kill.killID, GetKillReportHashValue(kill))
    invalid = killReportUtil.format_kill_report_url(kill.killID, '0' * 40)
    original_uicore = killReportUtil.uicore
    default_id = 'KillReportWnd'
    shifted_id = 'KillReport_%i' % kill.killID
    if KillReportWnd.GetIfOpen(default_id) or KillReportWnd.GetIfOpen(shifted_id):
        raise RuntimeError('The reference report window is already open')

    class ShiftedKeys(object):
        def Key(self, key):
            return key == killReportUtil.uiconst.VK_SHIFT

    class ShiftedCore(object):
        uilib = ShiftedKeys()

    try:
        killReportUtil.handle_kill_report_link(invalid)
        refused = KillReportWnd.GetIfOpen(default_id) is None
        killReportUtil.handle_kill_report_link(url)
        first = KillReportWnd.GetIfOpen(default_id)
        killReportUtil.handle_kill_report_link(url)
        reused = first is not None and first is KillReportWnd.GetIfOpen(default_id)
        killReportUtil.uicore = ShiftedCore()
        killReportUtil.handle_kill_report_link(url)
        shifted = KillReportWnd.GetIfOpen(shifted_id)
        return dict(station=session.stationid, killID=kill.killID, scheme=url.split(':')[0],
                    hashLength=len(url.split(':')[-1]), refused=refused, opened=first is not None,
                    reused=reused, shifted=shifted is not None and shifted is not first)
    finally:
        killReportUtil.uicore = original_uicore
        KillReportWnd.CloseIfOpen(shifted_id)
        KillReportWnd.CloseIfOpen(default_id)


result = observe()
