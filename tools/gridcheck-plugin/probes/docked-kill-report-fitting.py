import blue
from eve.client.script.ui.shared import killReport
from eve.client.script.ui.shared.fittingMgmtWindow import ViewFitting


def observe():
    if killReport.KillReportWnd.GetIfOpen() or ViewFitting.GetIfOpen('ViewFitting'):
        raise RuntimeError('The reference fitting or kill report window is already open')
    recent = sm.RemoteSvc('charMgr').GetRecentShipKillsAndLosses(25, None)
    if not recent:
        raise RuntimeError('The reference pilot has no kill report')
    kill = recent[0]
    original_simulate = killReport.SimulateFitting
    original_buy = killReport.BuyMultipleTypesWithQty
    observed = {}

    def record_simulate(fitting):
        observed['simulate'] = dict(hull=fitting.shipTypeID, modules=list(fitting.fitData))

    def record_buy(wanted):
        observed['buy'] = sorted(wanted.items())

    try:
        window = killReport.KillReportWnd.Open(windowID='KillReportWnd', killmail=kill)
        for _ in range(60):
            if window.involvedParties.text:
                break
            blue.synchro.SleepWallclock(100)
        if not window.involvedParties.text:
            raise RuntimeError('Kill report did not finish loading')
        killReport.SimulateFitting = record_simulate
        killReport.BuyMultipleTypesWithQty = record_buy
        window.SaveFitting()
        saved = ViewFitting.GetIfOpen('ViewFitting')
        window.SimulateFitting()
        window.BuyAll()
        return dict(station=session.stationid, killID=kill.killID, hull=kill.victimShipTypeID,
                    controls=dict(bar=bool(window.buttonCont.display), save=bool(window.savefittingBtn.display),
                                  simulate=bool(window.simulateFittingBtn.display)),
                    saveOpened=saved is not None, simulate=observed['simulate'], buy=observed['buy'])
    finally:
        killReport.SimulateFitting = original_simulate
        killReport.BuyMultipleTypesWithQty = original_buy
        ViewFitting.CloseIfOpen('ViewFitting')
        killReport.KillReportWnd.CloseIfOpen('KillReportWnd')


result = observe()
