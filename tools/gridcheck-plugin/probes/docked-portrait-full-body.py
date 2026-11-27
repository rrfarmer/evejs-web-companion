from eve.client.script.ui.shared.portraitWindow.portraitWindow import PortraitWindow
from eve.client.script.ui.shared.preview import PreviewCharacterWnd
from eveexceptions import UserError


def observe():
    if PortraitWindow.GetIfOpen() or PreviewCharacterWnd.GetIfOpen():
        raise RuntimeError('A character preview is already open')
    recent = sm.RemoteSvc('charMgr').GetRecentShipKillsAndLosses(25, None)
    report = next((each for each in recent if each.victimCharacterID), None)
    if report is None:
        raise RuntimeError('The reference pilot has no character loss report')
    char_id = report.victimCharacterID
    try:
        portrait = PortraitWindow.Open(charID=char_id)
        dna = sm.RemoteSvc('paperDollServer').GetPaperDollData(char_id)
        refusal = None
        try:
            portrait.SwitchToFullBody()
        except UserError as error:
            refusal = error.msg
        return dict(station=session.stationid, characterID=char_id, hasDNA=dna is not None,
                    action=portrait.switchBtn.label, refusal=refusal,
                    portraitOpen=PortraitWindow.GetIfOpen() is portrait,
                    fullBodyOpen=PreviewCharacterWnd.GetIfOpen() is not None)
    finally:
        PreviewCharacterWnd.CloseIfOpen()
        PortraitWindow.CloseIfOpen()


result = observe()
