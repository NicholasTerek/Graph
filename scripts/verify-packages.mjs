import {mkdtemp,mkdir,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {strict as assert} from 'node:assert';
const directory=await mkdtemp(join(tmpdir(),'graph-packages-'));
try{
 for(const name of ['contracts','sdk'])execFileSync('pnpm',['--dir',`packages/${name}`,'pack','--pack-destination',directory],{stdio:'pipe'});
 const consumer=join(directory,'consumer');await mkdir(consumer);const packages=(await readdir(directory)).filter(name=>name.endsWith('.tgz')).map(name=>join(directory,name));
 execFileSync('npm',['install','--prefix',consumer,'--ignore-scripts','--no-audit','--no-fund',...packages],{stdio:'pipe'});
 const {GraphClient}=await import(pathToFileURL(join(consumer,'node_modules/@graph/sdk/dist/index.js')).href);
 const {ontologySchema}=await import(pathToFileURL(join(consumer,'node_modules/@graph/contracts/dist/index.js')).href);
 assert.equal(ontologySchema.parse({id:'external',name:'External',objectTypes:[{name:'Thing',properties:{}}],relationshipTypes:[]}).id,'external');
 let authenticated=false;const client=new GraphClient('http://localhost',async(_url,init)=>{authenticated=!!new Headers(init.headers).get('authorization');return Response.json([]);},{token:()=>undefined});assert.deepEqual(await client.ontologies(),[]);assert.equal(authenticated,false);
 console.log('Packed SDK and contracts install and run in an independent consumer.');
}finally{await rm(directory,{recursive:true,force:true});}
