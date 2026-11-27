import blue
import utillib
from characterdata.npccharacters import iter_npc_characters
from eve.client.script.ui.shared.portraitWindow.portraitWindow import PortraitWindow
from eve.client.script.ui.shared.preview import PreviewCharacterWnd
from eve.common.script.paperDoll.paperDollDefinitions import ColorSelectionRow, ModifierRow, SculptingRow


def observe(gender, outfit, hair, apparel=(), sculpts=(), colors=()):
    if PortraitWindow.GetIfOpen() or PreviewCharacterWnd.GetIfOpen():
        raise RuntimeError('A character preview is already open')
    candidate = next((char_id for char_id, info in iter_npc_characters()
                      if info.gender == gender and info.bloodlineID == 8), None)
    if candidate is None:
        raise RuntimeError('No reference character has the selected paper-doll gender')
    modifiers = ([(10, outfit)] if outfit is not None else []) + [(5, hair)] + list(apparel)
    dna = utillib.KeyVal(sculpts=[SculptingRow(*row) for row in sculpts], colors=[ColorSelectionRow(*row) for row in colors],
                        modifiers=[ModifierRow(slot, resource, 0) for slot, resource in modifiers])
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
                      resource=cfg.paperdollResources.Get(outfit).resPath if outfit is not None else None,
                      apparel=[dict(slot=slot, resource=cfg.paperdollResources.Get(resource).resPath)
                               for slot, resource in apparel],
                      minSize=wnd.default_minSize, bounds=bounds, target=list(camera.atPosition),
                      verticalPan=scene.verticalPanEnabled)
        if colors:
            manager = preview.context.character.doll.buildDataManager
            eyes = [item for item in manager.GetModifiersAsList(showHidden=True) if 'eyes' in item.GetResPath().lower()]
            result['eyes'] = [dict(name=item.name, path=item.GetResPath(), colors=list(item.colorizeData), diffuse=dict(item.mapL), zones=dict(item.mapZ))
                              for item in eyes]
            result['makeup'] = [dict(path=item.GetResPath(), colors=list(item.colorizeData), weight=item.weight,
                                     diffuse=dict(item.mapL), zones=dict(item.mapZ))
                                for item in manager.GetModifiersAsList(showHidden=True)
                                if item.GetResPath().lower().startswith(('makeup/lipstick/', 'makeup/eyeliner/'))]
        if sculpts:
            doll = preview.context.character.doll
            result['sculpts'] = [dict(location=row[0], prefix=cfg.paperdollSculptingLocations.Get(row[0]).weightKeyPrefix,
                                      upDown=row[1], leftRight=row[2], forwardBack=row[3]) for row in sculpts]
            result['morphs'] = dict((key, value) for key, value in doll.buildDataManager.GetMorphTargets().iteritems()
                                    if value and key in ('jaw_downshape', 'nose_forwardshape', 'fatshape'))
            paths = {}
            for modifier in doll.buildDataManager.GetModifiersAsList():
                paths.update(modifier.meshGeometryResPaths)
            result['piercings'] = sorted(set(path.lower() for path in paths.values()
                                             if '/accessories/nose/' in path.lower() or '/accessories/earslow/' in path.lower()))
            result['meshTargets'] = [dict(name=name, file=paths.get(name, ''),
                                         names=sorted(set(names).intersection(result['morphs'])))
                                     for name, (raw, geometry, names) in doll.blendShapeMeshCache.iteritems()
                                     if names and set(names).intersection(result['morphs'])]
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
              layered=observe(0, 2225, 407, ((25, 236), (22, 298))),
              shirt=observe(0, None, 407, ((26, 3529), (25, 236), (22, 298))),
              sculpted=observe(0, 8649, 407, sculpts=((18, -0.75, 0.0, 0.0), (27, 0.0, 0.0, 0.4))),
              bodySculpt=observe(0, None, 407, ((26, 3529), (25, 236), (22, 298)),
                                 sculpts=((5, 0.5, 0.0, 0.0),)),
              pierced=observe(0, None, 407, ((26, 3529), (25, 236), (22, 298), (12, 824), (4, 614)),
                              sculpts=((18, -0.75, 0.0, 0.0), (27, 0.0, 0.0, 0.4), (5, 0.5, 0.0, 0.0))),
              iris=observe(0, 8649, 407, ((6, 79),), colors=((7, 153, 0, 0.0, 0.0),)),
              makeup=observe(0, 8649, 407, ((7, 215), (17, 75)),
                             colors=((8, 13, 0, 0.65, 0.2), (16, 24, 0, 0.45, 0.0))))
