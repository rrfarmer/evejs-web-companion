import blue
import evetypes
from eve.common.script.sys.eveCfg import IsPreviewable
from eve.client.script.ui.shared.killReport import KillReportWnd
from eve.client.script.ui.shared.preview import PreviewWnd


def observe():
    if KillReportWnd.GetIfOpen() or PreviewWnd.GetIfOpen():
        raise RuntimeError('A preview or report window is already open')
    recent = sm.RemoteSvc('charMgr').GetRecentShipKillsAndLosses(25, None)
    if not recent:
        raise RuntimeError('The reference pilot has no kill report')
    windows = []
    try:
        report = KillReportWnd.Open(windowID='KillReportWnd', killmail=recent[0])
        for type_id in (35832, 33475):
            report.OpenPreview(type_id)
            for _ in range(75):
                preview = PreviewWnd.GetIfOpen()
                if preview and preview.typeID == type_id and preview.title.text:
                    break
                blue.synchro.SleepWallclock(100)
            if not preview or preview.typeID != type_id:
                raise RuntimeError('Preview did not open for %s' % type_id)
            windows.append((preview, dict(typeID=type_id, name=evetypes.GetName(type_id),
                                          caption=preview.GetCaption(), title=preview.title.text)))
        report.OpenPreview(34)
        ignored = PreviewWnd.GetIfOpen() is windows[-1][0] and windows[-1][0].typeID == 33475
        return dict(station=session.stationid, previews=[each[1] for each in windows],
                    reused=windows[0][0] is windows[1][0], ignored=ignored, mineral=bool(IsPreviewable(34)))
    finally:
        PreviewWnd.CloseIfOpen()
        KillReportWnd.CloseIfOpen()


result = observe()
