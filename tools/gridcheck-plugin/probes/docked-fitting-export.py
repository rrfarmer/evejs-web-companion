# Read native fitting-export owner, filename control, and XML slot labels without writing a file.
from eve.client.script.ui.shared.export import ExportFittingsWindow
from localization import GetByLabel

window = ExportFittingsWindow.Open(ownerID=session.charid)
try:
    flags = [11, 19, 27, 92, 125, 5, 87, 158, 164]
    result = {
        'title': GetByLabel('UI/Fitting/ExportFittings'),
        'owner': window.selectedOwnerID,
        'filename': window.sr.filename.GetValue(),
        'slots': [[flag, window.GetSlotFromFlag(flag)] for flag in flags],
    }
finally:
    window.Close()
