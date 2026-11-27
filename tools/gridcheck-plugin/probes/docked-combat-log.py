import blue
from carbonui.uicore import uicore
from crimewatch.util import GetKillReportHashValue
from eve.client.script.ui.shared.killReportUtil import CleanKillMail
from eve.client.script.ui.shared.neocom import charsheet
from eve.client.script.ui.shared.neocom.charsheet.charSheetUtil import GetCombatEntries
from eve.client.script.ui.shared.neocom.characterSheetWindow import CharacterSheetWindow
from eve.common.script.util.esiUtils import GetESIKillmailUrl
from eve.common.script.util.eveCommonUtils import CombatLog_CopyText
from localization import GetByLabel
from utillib import KeyVal


def observe():
    old = CharacterSheetWindow.GetIfOpen()
    if not old:
        uicore.cmd.OpenCharactersheet()
    window = CharacterSheetWindow.GetIfOpen()
    saved = settings.user.ui.Get('charsheet_condensedcombatlog', 0)
    panel = None
    try:
        window._StartLoadingPanel(charsheet.PANEL_STANDINGS, autoExpand=True)
        blue.pyos.synchro.SleepWallclock(650)
        window.interactionsPanel.LoadSubPanel(charsheet.PANEL_COMBATLOG)
        panel = window.interactionsPanel.combatLogPanel
        info = sm.GetService('info')
        sample = KeyVal(killID=99001, killTime=134402456800000000L, solarSystemID=30000144,
                        moonID=None, victimCharacterID=session.charid, victimCorporationID=session.corpid,
                        victimAllianceID=None, victimFactionID=None, victimShipTypeID=670, victimDamageTaken=53,
                        finalCharacterID=None, finalCorporationID=1000125, finalAllianceID=None, finalFactionID=None,
                        finalShipTypeID=587, finalWeaponTypeID=484, finalSecurityStatus=0, finalDamageDone=53,
                        killBlob='<attackers></attackers><items><i t=34 f=5 s=0 d=3 x=0/></items>')
        settings.user.ui.Set('charsheet_condensedcombatlog', 1)
        compact, headers = GetCombatEntries([sample])
        filtered, _ = GetCombatEntries([sample], filterText='capsule')
        rejected, _ = GetCombatEntries([sample], filterText='impossible-fixture-token')
        return dict(station=session.stationid, pageSize=panel.killentries,
                    counts=[len(info.GetKillsRecentKills(25, None)), len(info.GetKillsRecentLosses(25, None))],
                    buttons=[GetByLabel(label) for label in [
                        'UI/Corporations/Wars/Killmails/ShowKills', 'UI/Corporations/Wars/Killmails/ShowLosses',
                        'UI/CharacterSheet/CharacterSheetWindow/KillsTabs/CondensedCombatLog',
                        'UI/CharacterSheet/CharacterSheetWindow/KillsTabs/NoKillsFound',
                        'UI/CharacterSheet/CharacterSheetWindow/KillsTabs/NoLossesFound',
                        'UI/Control/Entries/CopyExternalKillLink']],
                    headers=headers, sample=compact[0].label, matches=[len(filtered), len(rejected)],
                    hash=GetKillReportHashValue(sample), external=GetESIKillmailUrl(sample),
                    text=CleanKillMail(CombatLog_CopyText(sample)))
    finally:
        settings.user.ui.Set('charsheet_condensedcombatlog', saved)
        if not old:
            window.Close()


result = observe()
