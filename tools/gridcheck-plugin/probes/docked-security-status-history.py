import blue
from carbonui.uicore import uicore
from eve.client.script.ui.shared.neocom import charsheet
from eve.client.script.ui.shared.neocom.characterSheetWindow import CharacterSheetWindow
from localization import GetByLabel
from utillib import KeyVal


def observe():
    opening = CharacterSheetWindow.GetIfOpen()
    if not opening:
        uicore.cmd.OpenCharactersheet()
    window = CharacterSheetWindow.GetIfOpen()
    if not window:
        raise RuntimeError('Character Sheet did not open')
    service = sm.GetService('crimewatchSvc')
    initial = service.GetSecurityStatusTransactions()
    now = blue.os.GetWallclockTime()
    # Feed native UI five event types when the reference server has no history.
    sample = [KeyVal(eventTypeID=event, eventDate=now-index*10000000, modification=change,
                     newValue=value, otherOwnerID=owner, otherTypeID=type_id, locationID=30000144)
              for index, (event, change, value, owner, type_id) in enumerate([
                  (380, None, -1.25, session.charid, 670), (386, None, -1.0, session.charid, 670),
                  (379, -0.014825, -1.82456, session.charid, 670), (378, 0.001235, -1.80333, 1000125, 670),
                  (385, None, -1.3, session.charid, 670)])]
    try:
        window._StartLoadingPanel(charsheet.PANEL_SECURITYSTATUS, autoExpand=True)
        blue.pyos.synchro.SleepWallclock(550)
        panel = window.interactionsPanel.securityStatusPanel
        empty = panel.scroll.GetNodes()
        original = service.GetSecurityStatusTransactions
        service.GetSecurityStatusTransactions = lambda: sample
        try:
            panel.LoadPanel()
            rows = [dict(text=node.text, hint=node.hint, details=node.details, hasDetails=node.isNPC)
                    for node in panel.scroll.GetNodes()]
        finally:
            service.GetSecurityStatusTransactions = original
            if opening:
                panel.LoadPanel()
        return dict(station=session.stationid, initialCount=len(initial), initialRows=len(empty), rows=rows,
                    headers=[GetByLabel(label) for label in [
                        'UI/Common/Date', 'UI/Common/Change', 'UI/CharacterSheet/CharacterSheetWindow/SecurityStatus',
                        'UI/CharacterSheet/CharacterSheetWindow/SecurityStatusScroll/Subject']],
                    empty=GetByLabel('UI/CharacterSheet/CharacterSheetWindow/SecurityStatusScroll/NoSecurityStatusChanges'),
                    details=GetByLabel('UI/Standings/TransactionWindow/Details'))
    finally:
        if not opening:
            window.Close()


result = observe()
