import trinity
from evegraphics import utils as gfxutils

factory = sm.GetService('sofService').spaceObjectFactory
shader = factory.GetSofDB().generic.bannerShader
models = {}
for type_id in (32880, 587, 670):
    model = factory.BuildFromDNA(gfxutils.BuildSOFDNAFromTypeID(type_id))
    banners = []
    for attachment in model.attachments:
        if not isinstance(attachment, trinity.EveBannerSet):
            continue
        effect = attachment.effect
        banners.append(dict(name=attachment.name, effect=effect.effectFilePath,
                            parameters=[p.name for p in effect.parameters],
                            resources=[(r.name, r.resourcePath) for r in effect.resources],
                            fields=[n for n in dir(attachment) if 'item' in n.lower() or 'transform' in n.lower() or 'geometry' in n.lower()]))
    models[str(type_id)] = dict(banners=banners, external=[p.name for p in model.externalParameters])

result = dict(station=session.stationid, shader=shader.shader, models=models,
              parameters={p.name: list(p.value) for p in shader.defaultParameters},
              textures={t.name: t.resFilePath for t in shader.defaultTextures})
