import blue
from carbonui.uicore import uicore
from localization import GetByLabel
from shipcosmetics.utils.indexcast import group_and_slot_index_to_backend
from eve.client.script.ui.shared.fittingScreen.fittingWnd import FittingWindow, TAB_ID_COSMETIC
from eve.client.script.ui.shared.fittingScreen.cosmetics.cosmeticFitting import TAB_ID_EMBLEMS

opened = FittingWindow.GetIfOpen()
if not opened:
    uicore.cmd.OpenFitting()
window = FittingWindow.GetIfOpen()
try:
    window.fittingModeTabGroup.SelectByID(TAB_ID_COSMETIC)
    blue.pyos.synchro.SleepWallclock(500)
    window.cosmeticsPanel.GoToTab(TAB_ID_EMBLEMS)
    blue.pyos.synchro.SleepWallclock(450)
    svc = sm.GetService('cosmeticsLicenseSvc')
    results = {}
    for hull in (670, 587, 32880):
        results[str(hull)] = [dict(kind=int(row.cosmeticType), slot=group_and_slot_index_to_backend(row.slotGroup, int(row.cosmeticType) - 1), license=row.fsdTypeID)
                              for row in svc.get_ship_licenses_for_ship_type(hull)]
    equipped = sm.RemoteSvc('shipCosmeticsMgr').GetEnabledCosmetics(session.shipid)
    result = dict(station=session.stationid, hulls=results, equipped=list(equipped.items()),
                  tab=window.cosmeticsPanel.cosmeticTypeTabGroup.GetSelectedID(),
                  labels=[GetByLabel('UI/ShipCosmetics/' + name) for name in ('Emblems','AvailableAllianceEmblems','AvailableCorporationEmblems','EmblemNotReleased','EmblemNoAllianceNotEligible','EmblemNoAllianceEligible')])
finally:
    if window and not opened:
        window.Close()
