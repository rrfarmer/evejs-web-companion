# Open the native Structure Browser through its Neocom command and read its initial panel.
from eve.client.script.ui.structure.structureBrowser.structureBrowserWnd import StructureBrowserWnd
from eve.common.script.sys.idCheckers import IsNPCCorporation
from localization import GetByLabel

cmd = sm.GetService('cmd')
already_open = StructureBrowserWnd.GetIfOpen() is not None
if not already_open:
    cmd.OpenStructureBrowser()
window = StructureBrowserWnd.GetIfOpen()
try:
    directory = sm.GetService('structureDirectory').GetStructures()
    result = {'caption': GetByLabel(window.default_captionLabelPath),
              'defaultSize': [window.default_width, window.default_height],
              'minSize': list(window.default_minSize), 'npcCorporation': bool(IsNPCCorporation(session.corpid)),
              'tabbed': window.tabs is not None, 'initialPanel': window.browserAllStructures.default_name,
              'systemID': session.solarsystemid2,
              'localDirectoryIDs': sorted(row['structureID'] for row in directory.itervalues()
                                          if row['solarSystemID'] == session.solarsystemid2)}
finally:
    if not already_open and window is not None:
        cmd.OpenStructureBrowser()
