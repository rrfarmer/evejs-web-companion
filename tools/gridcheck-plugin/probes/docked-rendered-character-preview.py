import blue
import utillib
from characterdata.npccharacters import iter_npc_characters
from eve.client.script.ui.shared.portraitWindow.portraitWindow import PortraitWindow
from eve.client.script.ui.shared.preview import PreviewCharacterWnd
from eve.common.script.paperDoll.paperDollDefinitions import ModifierRow


def observe(gender, outfit, hair, apparel=()):
    if PortraitWindow.GetIfOpen() or PreviewCharacterWnd.GetIfOpen():
        raise RuntimeError('A character preview is already open')
    candidate = next((char_id for char_id, info in iter_npc_characters()
                      if info.gender == gender and info.bloodlineID == 8), None)
    if candidate is None:
        raise RuntimeError('No reference character has the selected paper-doll gender')
    modifiers = [(10, outfit), (5, hair)] + list(apparel)
    dna = utillib.KeyVal(sculpts=[], colors=[], modifiers=[ModifierRow(slot, resource, 0) for slot, resource in modifiers])
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
        result = dict(station=session.stationid, characterID=candidate, windowID=wnd.windowID, outfit=outfit,
                      resource=cfg.paperdollResources.Get(outfit).resPath,
                      apparel=[dict(slot=slot, resource=cfg.paperdollResources.Get(resource).resPath)
                               for slot, resource in apparel],
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


result = dict(female=observe(0, 15525, 407), male=observe(1, 15555, 127),
              layered=observe(0, 2225, 407, ((25, 236), (22, 298))))
