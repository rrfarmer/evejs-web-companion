import test from "node:test";
import assert from "node:assert/strict";
import {validSavedSiteClassification,sameSiteClassification} from "./siteSelection.ts";
import type {NativeSite} from "./siteDiscovery.ts";
const ore:NativeSite={scannerKey:5830002781001,instanceID:3547,label:"Any label",archetypeID:27,observedAt:1,sourceDungeonID:1456,siteFamily:"ORE",target:{kind:"ORE_ANOMALY",systemID:30002781,name:"Any label",siteID:5830002781001,instanceID:3547,position:{x:0,y:0,z:0}}};
test("saved classified choice must reproduce native namespace and source",()=>{assert.equal(validSavedSiteClassification(ore),true);assert.equal(validSavedSiteClassification({...ore,siteFamily:"MOON"}),false);assert.equal(validSavedSiteClassification({...ore,sourceDungeonID:null}),false);assert.equal(validSavedSiteClassification({...ore,siteFamily:"UNKNOWN"}),false);assert.equal(validSavedSiteClassification({...ore,siteFamily:undefined}),false);});
test("fresh family or source changes cannot authorize the reviewed choice",()=>{assert.equal(sameSiteClassification(ore,{...ore,observedAt:100}),true);for(const changed of [{siteFamily:"MOON" as const},{sourceDungeonID:1413},{siteFamily:undefined,sourceDungeonID:undefined}])assert.equal(sameSiteClassification(ore,{...ore,...changed}),false);});
test("legacy records preserve their exact prior target without fabricating classification",()=>{const {siteFamily,sourceDungeonID,...legacy}=ore;assert.equal(validSavedSiteClassification(legacy),true);assert.equal(sameSiteClassification(legacy,ore),true);assert.equal(sameSiteClassification(ore,legacy),false);});
