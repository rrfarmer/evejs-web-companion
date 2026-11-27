import blue
import utillib
from characterdata.npccharacters import iter_npc_characters
from eve.client.script.ui.shared.portraitWindow.portraitWindow import PortraitWindow
from eve.client.script.ui.shared.preview import PreviewCharacterWnd
from eve.common.script.paperDoll.paperDollDefinitions import ModifierRow


def observe():
    if PortraitWindow.GetIfOpen() or PreviewCharacterWnd.GetIfOpen():
        raise RuntimeError('A character preview is already open')
    candidate = next((char_id for char_id, info in iter_npc_characters()
                      if info.gender == 0 and info.bloodlineID == 8), None)
    if candidate is None:
        raise RuntimeError('No reference character has female paper-doll geometry')
    dna = utillib.KeyVal(sculpts=[], colors=[], modifiers=[ModifierRow(10, 8649, 0), ModifierRow(5, 407, 0)])
    try:
        wnd = PreviewCharacterWnd.Open(charID=candidate, dna=dna)
        preview = wnd.previewContainer
        scene = preview.sceneContainer
        for _ in range(80):
            context = preview.context
            if (context and context.character is not None and getattr(context, 'boundingBox', None)
                    and scene.verticalPanEnabled and abs(scene.camera.atPosition[1]) > 0.1):
                break
            blue.synchro.SleepWallclock(100)
        camera = scene.camera
        measured = getattr(preview.context, 'boundingBox', None)
        if not measured:
            raise RuntimeError('Character preview did not report bounds')
        bounds = [list(point) for point in measured]
        result = dict(station=session.stationid, characterID=candidate, windowID=wnd.windowID,
                      minSize=wnd.default_minSize, bounds=bounds, target=list(camera.atPosition),
                      verticalPan=scene.verticalPanEnabled)
        wnd.SwitchToPortrait(candidate)
        portrait = PortraitWindow.GetIfOpen()
        result.update(viewPortraitClosedPreview=PreviewCharacterWnd.GetIfOpen() is None,
                      viewPortraitOpenedPortrait=portrait is not None,
                      portraitAction=portrait.switchBtn.label if portrait else None)
        return result
    finally:
        PreviewCharacterWnd.CloseIfOpen()
        PortraitWindow.CloseIfOpen()


result = observe()
