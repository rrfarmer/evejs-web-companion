# Observe the standalone Fitting Management window without changing saved fittings.
import blue
from eve.client.script.ui.shared.fittingMgmtWindow import FittingMgmt
from localization import GetByLabel

existing = FittingMgmt.GetIfOpen()
window = existing or FittingMgmt.Open()
try:
    blue.synchro.SleepWallclock(100)
    result = {
        'title': GetByLabel(window.default_captionLabelPath),
        'windowID': window.default_windowID,
        'rect': list(window.GetAbsolute()),
        'minimum': list(window.default_minSize),
        'personal': GetByLabel('UI/Fitting/FittingWindow/FittingManagement/PersonalFittings'),
        'corporation': GetByLabel('UI/Fitting/FittingWindow/FittingManagement/CorporationFittings'),
        'hint': GetByLabel('UI/Fitting/FittingWindow/FittingManagement/NoFittingSelected'),
        'owners': [session.charid, session.corpid, session.allianceid],
    }
finally:
    if existing is None:
        window.Close()
