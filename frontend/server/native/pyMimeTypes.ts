/**
 * Python's `mimetypes` table as ComfyUI's engine sees it: the extension →
 * top-level type map `mimetypes.guess_type(name, strict=False)` consults after
 * `utils/mime_types.py:init_mime_types()` (Python 3.12, which also reads
 * /etc/apache2/mime.types on macOS). Only the top-level type matters to
 * `folder_paths.filter_files_content_types`, so every extension that is not
 * image/video/audio/model is listed under `other` — still needed, because a
 * KNOWN non-media extension is cached by the filter while an unknown one is not.
 *
 * Derived once, while the Python tree still existed, by running:
 *   python -c "import sys;sys.argv=['x'];from utils.mime_types import init_mime_types;init_mime_types();import mimetypes;d=mimetypes._db;print({e:(d.types_map[True].get(e) or d.types_map[False][e]).split('/')[0] for e in set(d.types_map[True])|set(d.types_map[False])})"
 */
const TABLE: Record<'image' | 'video' | 'audio' | 'model' | 'other', string> = {
  image: [
    '3ds avif bmp btif cgm cmx djv djvu dwg dxf fbs fh fh4 fh5 fh7 fhc fpx fst g3 gif heic heif ico ief',
    'jp2 jpe jpeg jpg ktx mac mdi mmr npx pbm pct pcx pgm pic pict png pnm pnt pntg ppm psd qti qtif ras',
    'rgb rlc sgi sid svg svgz tga tif tiff uvg uvi uvvg uvvi wbmp wdp webp xbm xif xpm xwd',
  ].join(' '),
  video: [
    '3g2 3gp asf asx avi dif dv dvb f4v fli flv fvt h261 h263 h264 jpgm jpgv jpm m1v m2t m2ts m2v m4u m4v',
    'mj2 mjp2 mk3d mks mkv mng mov movie mp4 mp4v mpa mpe mpeg mpg mpg4 mts mxu ogv pyv qt smv ts uvh uvm',
    'uvp uvs uvu uvv uvvh uvvm uvvp uvvs uvvu uvvv viv vob webm wm wmv wmx wvx',
  ].join(' '),
  audio: [
    '3gpp 3gpp2 aac adp adts aif aifc aiff ass au caf dra dts dtshd ecelp4800 ecelp7470 ecelp9600 eol',
    'flac kar loas lvp m2a m3a m3u m4a m4p mid midi mka mp2 mp2a mp3 mp4a mpga oga ogg opus pya ra ram',
    'rip rmi rmp s3m sil snd spx uva uvva wav wax weba wma xm',
  ].join(' '),
  model: [
    'dae dwf gdl gtw iges igs mesh msh silo vrml vtu wrl x3d x3db x3dbz x3dv x3dvz x3dz',
  ].join(' '),
  other: [
    '123 3dml 7z a aab aam aas abw ac acc ace acu acutc aep afm afp ahead ai air ait ami apk appcache',
    'application apr arc asc asm aso atc atom atomcat atomsvc atx aw azf azs azw bat bcpio bdf bdm bed',
    'bh2 bin blb blorb bmi book box boz bpk bz bz2 c c11amc c11amz c4d c4f c4g c4p c4u cab cap car cat',
    'cb7 cba cbr cbt cbz cc cct ccxml cdbcmsg cdf cdkey cdmia cdmic cdmid cdmio cdmiq cdx cdxml cdy cer',
    'cfs chat chm chrt cif cii cil ckpt cla class clkk clkp clkt clkw clkx clp cmc cmdf cml cmp cod com',
    'conf cpio cpp cpt crd crl crt cryptonote csh csml csp css cst csv cu curl cww cxt cxx daf dart',
    'dataless davmount dbk dcr dcurl dd2 ddd deb def deploy der dfac dgc dic dir dis dist distz dll dmg',
    'dmp dms dna doc docm docx dot dotm dotx dp dpg dsc dssc dtb dtd dump dvi dxp dxr ecma edm edx efif',
    'ei6 elc emf eml emma emz eot eps epub es3 esa esf et3 etx eva evy exe exi ext ez ez2 ez3 f f77 f90',
    'fcdt fcs fdf fe_launch fg5 fgd fig flo flw flx fly fm fnc for frame fsc ftc fti fxp fxpl fzs g2w g3w',
    'gac gam gbr gca geo gex ggb ggs ggt gguf ghf gim gml gmx gnumeric gph gpx gqf gqs gram gramps gre',
    'grv grxml gsf gtar gtm gv gxf gxt h h5 hal hbci hdf hh hlp hpgl hpid hps hqx htke htm html hvd hvp',
    'hvs i2g icc ice icm ics ifb ifm igl igm igx iif imp ims in ink inkml install iota ipfix ipk irm irp',
    'iso itp ivp ivu jad jam jar java jisp jlt jnlp joda js json jsonml karbon kfo kia kml kmz kne knp',
    'kon kpr kpt kpxx ksh ksp ktr ktz kwd kwt lasxml latex lbd lbe les lha link66 list list3820 listafp',
    'lnk log lostxml lrf lrm ltf lwp lzh m13 m14 m21 m3u8 ma mads mag maker man manifest mar markdown',
    'mathml mb mbk mbox mc1 mcd mcurl md mdb me meta4 metalink mets mfm mft mgp mgz mht mhtml mie mif',
    'mime mjs mlp mmd mmf mny mobi mobipocket-ebook mods mp21 mp4s mpc mpkg mpm mpn mpp mpt mpy mqy mrc',
    'mrcx ms mscml mseed mseq msf msi msl msty mus musicxml mvb mwf mxf mxl mxml mxs n-gage n3 nb nbp nc',
    'ncx nfo ngdat nitf nlu nml nnd nns nnw nq nsc nsf nt ntf nws nzb o oa2 oa3 oas obd obj oda odb odc',
    'odf odft odg odi odm odp ods odt ogx omdoc onepkg onetmp onetoc onetoc2 opf opml oprc org osf osfpvg',
    'otc otf otg oth oti otp ots ott oxps oxt p p10 p12 p7b p7c p7m p7r p7s p8 pas paw pbd pcap pcf pcl',
    'pclxl pcurl pdb pdf pfa pfb pfm pfr pfx pgn pgp pkg pki pkipath pkl pl plb plc plf pls pml portpkg',
    'pot potm potx ppa ppam ppd pps ppsm ppsx ppt pptm pptx pqa prc pre prf ps psb psf pskcxml pt pth',
    'ptid pub pvb pwn pwz py pyc pyo qam qbo qfx qps qwd qwt qxb qxd qxl qxt rar rcprofile rdf rdz rep',
    'res rif ris rl rld rm rms rmvb rnc roa roff rp9 rpss rpst rq rs rsd rss rst rtf rtx s saf',
    'safetensors sbml sc scd scm scq scs scurl sda sdc sdd sdkd sdkm sdp sdw see seed sema semd semf ser',
    'setpay setreg sfd-hdstx sfs sft sfv sgl sgm sgml sh shar shf sig sis sisx sit sitx skd skm skp skt',
    'sldm sldx slt sm smf smi smil smzip snf so spc spf spl spot spp spq sql src srt sru srx ssdl sse ssf',
    'ssml st stc std stf sti stk stl str stw sub sus susp sv4cpio sv4crc svc svd swa swf swi sxc sxd sxg',
    'sxi sxm sxw t t3 taglet tao tar tcap tcl teacher tei teicorpus tex texi texinfo text tfi tfm thmx',
    'tmo torrent tpl tpt tr tra trig trm tsd tsv ttc ttf ttl twd twds txd txf txt u32 udeb ufd ufdl ulx',
    'umj unityweb uoml uri uris urls ustar utz uu uvd uvf uvt uvvd uvvf uvvt uvvx uvvz uvx uvz vcard vcd',
    'vcf vcg vcs vcx vis vor vox vsd vsf vss vst vsw vtt vxml w3d wad wasm wbs wbxml wcm wdb webmanifest',
    'wg wgt wiz wks wmd wmf wml wmlc wmls wmlsc wmz woff woff2 wpd wpl wps wqd wri wsdl wspolicy wtb x32',
    'xaml xap xar xbap xbd xdf xdm xdp xdssc xdw xenc xer xfdf xfdl xht xhtml xhvml xla xlam xlb xlc xlf',
    'xlm xls xlsb xlsm xlsx xlt xltm xltx xlw xml xo xop xpdl xpi xpl xpr xps xpw xpx xsl xslt xsm xspf',
    'xul xvm xvml xyz xz yaml yang yin yml z1 z2 z3 z4 z5 z6 z7 z8 zaz zip zir zirz zmm',
  ].join(' '),
}

/** `.ext` (lower case) → top-level type, `other` for a known non-media type. */
export const PY_MIME_TOP: ReadonlyMap<string, string> = new Map(
  (Object.entries(TABLE) as [string, string][]).flatMap(([top, exts]) => exts.split(' ').map(e => [`.${e}`, top] as [string, string])),
)

/** `mimetypes.suffix_map` (looked up lower-cased). */
export const PY_SUFFIX_MAP: Readonly<Record<string, string>> = {
  '.svgz': '.svg.gz', '.tgz': '.tar.gz', '.taz': '.tar.gz', '.tz': '.tar.gz', '.tbz2': '.tar.bz2', '.txz': '.tar.xz',
}

/** `mimetypes.encodings_map` keys (case sensitive). */
export const PY_ENCODING_SUFFIXES: ReadonlySet<string> = new Set(['.gz', '.Z', '.bz2', '.xz', '.br'])
