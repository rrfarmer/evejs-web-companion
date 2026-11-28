from types import FunctionType

import blue
from charactercreator.client import animparams
from characterdata.npccharacters import iter_npc_characters
from eve.client.script.ui.shared.preview import PreviewCharacterWnd
from eve.common.script.paperDoll.paperDollDefinitions import AppearanceRow
from utillib import KeyVal


def observe():
    if PreviewCharacterWnd.GetIfOpen():
        raise RuntimeError('Close the existing character preview before probing')

    calls = []
    method = animparams.AnimParams.ProcessControlParameter.__func__
    dispatch = KeyVal(new=lambda handler, *args: calls.append(handler.__name__))
    trace_dispatch = FunctionType(method.func_code, dict(method.func_globals, uthread=dispatch),
                                  method.func_name, method.func_defaults, method.func_closure)

    class ObservedParams(animparams.AnimParams):
        ProcessControlParameter = trace_dispatch

    samples = []
    for gender in (0, 1):
        pilot = next(char_id for char_id, info in iter_npc_characters()
                     if info.gender == gender and info.bloodlineID == 8)
        dna = KeyVal(appearance=AppearanceRow(0.5), sculpts=[], colors=[], modifiers=[])
        try:
            window = PreviewCharacterWnd.Open(charID=pilot, dna=dna)
            for _ in range(80):
                context = window.previewContainer.context
                if context and getattr(context, 'boundingBox', None):
                    break
                blue.synchro.SleepWallclock(100)
            if not context or not getattr(context, 'boundingBox', None):
                raise RuntimeError('Character preview did not report bounds')
            avatar = context.character.avatar
            params = ObservedParams(avatar, charID=pilot)
            for field, values in (
                ('WeightAdjustment', (0.0, 0.25, 0.5, 0.75, 1.0)),
                ('HeadLookLeftRight', (0.25, 0.75)),
            ):
                name = 'ControlParameters|' + field
                registered = name in params.GetAllControlParameters()
                for value in values:
                    del calls[:]
                    params.SetControlParameter(name, value)
                    samples.append(dict(gender=gender, field=field, registered=registered,
                                        value=params.GetControlParameter(name), dispatched=list(calls)))
        finally:
            PreviewCharacterWnd.CloseIfOpen()
    return dict(station=session.stationid, samples=samples)


result = observe()
