from types import FunctionType

from eve.client.script.ui.login import characterCreationContainer_new as creation
from utillib import KeyVal


def observe():
    controller = creation.CharacterCreationContainer_new
    pilot = session.charid
    calls = []
    portrait = KeyVal(backgroundID=1)
    appearance = KeyVal(sculpts=['saved sculpt rows'])

    def record(name):
        return lambda *args, **kwargs: calls.append(dict(name=name, args=list(args), kwargs=kwargs))

    cc = KeyVal(GetMyApparel=lambda: [], UpdateExistingCharacterBloodline=record('bloodline'),
                UpdateExistingCharacterFull=record('full'), UpdateExistingCharacterLimited=record('limited'))
    services = KeyVal(GetService=lambda name: {'cc': cc, 'photo': KeyVal(AddPortrait=record('photo'))}[name])
    raw = controller.UpdateExistingCharacter.__func__
    update = FunctionType(raw.func_code, dict(raw.func_globals, sm=services), raw.func_name, raw.func_defaults, raw.func_closure)
    samples = []
    for state in (creation.paperdoll.State.no_recustomization, creation.paperdoll.State.resculpting):
        del calls[:]
        mode = controller.GetModeIDForDollState.__func__(None, state)
        editor = KeyVal(_activeCharID=pilot, _characterData={pilot: KeyVal(dna=appearance)},
                        portraitManager=KeyVal(GetActivePortraitInfo=lambda: portrait, activePortraitIndex=0,
                                               GetPortraitSnapshotPath=lambda index: 'fixture'),
                        characterSvc=KeyVal(GetCharacterAppearanceInfo=lambda char_id: appearance,
                                            characterMetadata={pilot: KeyVal(types={})}, CachePortraitInfo=lambda *args: None),
                        GetInfo=lambda: KeyVal(bloodlineID=1), mode=mode, dollState=state,
                        metrics=KeyVal(complete_cc=lambda **kwargs: None), ExitToStation=record('exit'))
        update(editor)
        for call in calls:
            if call['name'] in ('full', 'limited'):
                args = call['args']
                call['args'] = [args[0], list(args[1].sculpts), args[2].backgroundID, args[3]]
        samples.append(dict(state=state, mode=mode, calls=list(calls)))
    return dict(station=session.stationid, rows=samples)


result = observe()
