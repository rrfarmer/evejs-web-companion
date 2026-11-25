# Observe a native fitting-tree shell and verify owner memory without saving any fitting.
import evetypes
import utillib
from eve.client.script.ui.shared.fittingMgmtWindow import FittingMgmt
from localization import GetByLabel

previous = settings.user.ui.Get('savedFittingsCombo', None)
opened = FittingMgmt.GetIfOpen()
if opened is not None:
    raise RuntimeError('Fitting Management must start closed')
window = FittingMgmt.Open()
try:
    hull = 32880
    synthetic = utillib.KeyVal(shipTypeID=hull, fittingID=1, name='Gridcheck sample')
    hullNodes = window.GetShipGroupSubContent(utillib.KeyVal(fittings=[synthetic]))
    fitNodes = window.GetFittingSubContent(hullNodes[0])
    window.ChangeOwnerFilter(None, None, session.corpid)
    remembered = settings.user.ui.Get('savedFittingsCombo', None)
    window.Close()
    window = FittingMgmt.Open()
    result = {
        'group': evetypes.GetGroupNameByGroup(evetypes.GetGroupID(hull)),
        'hull': hullNodes[0].label,
        'fitting': fitNodes[0].label,
        'collapse': GetByLabel('UI/Common/Buttons/CollapseAll'),
        'remembered': remembered == session.corpid and window._selected_owner_id == session.corpid,
    }
finally:
    window.Close()
    settings.user.ui.Set('savedFittingsCombo', previous)
