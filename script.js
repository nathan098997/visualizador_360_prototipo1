// Configuração dos projetos com persistência em localStorage
const STORAGE_KEY = 'vj360_projects';
const DEFAULT_PROJECTS = {
    'projeto-demo': {
        password: '123456',
        image: 'https://pannellum.org/images/alma.jpg',
        title: 'Projeto Demo',
        createdAt: new Date().toISOString()
    },
    'casa-modelo': {
        password: 'casa2024',
        image: 'https://pannellum.org/images/cerro-toco-0.jpg',
        title: 'Casa Modelo',
        createdAt: new Date().toISOString()
    },
    'apartamento-luxo': {
        password: 'luxo789',
        image: 'https://pannellum.org/images/jfk.jpg',
        title: 'Apartamento de Luxo',
        createdAt: new Date().toISOString()
    }
};

function loadProjects() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { ...DEFAULT_PROJECTS };
        return JSON.parse(raw);
    } catch (e) {
        console.warn('Falha ao carregar projetos do localStorage, usando padrão.', e);
        return { ...DEFAULT_PROJECTS };
    }
}

function saveProjects() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
    } catch (e) {
        console.error('Falha ao salvar projetos.', e);
    }
}

let projects = loadProjects();

const ADMIN_PASSWORD = 'admin123'; // Em produção, mover para backend
let viewer = null;
let previewViewer = null;
let hotspots = [];
let addingHotspot = false;
let editingHotspot = null;
let currentParentId = null; // null = cena principal; caso contrário = hotspot pai
let previewClickBound = false;
let previewCurrentImage = null; // imagem atual usada no preview
let previewRootImage = null;    // imagem raiz (cena principal)

// ===== Navegação Hierárquica (Street View-like) =====
const StorageKeys = {
  MAP: '360:map',
  PROGRESS: '360:progress'
};

const StorageUtil = {
  save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
  load(key, fallback = null) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
  }
};

function deepClone(obj){ return JSON.parse(JSON.stringify(obj)); }

class MapModel {
  constructor(mapJson){
    this.initialNodeId = mapJson.initialNodeId || mapJson.inicial || Object.keys(mapJson.pontos||mapJson.nodes||{})[0];
    // aceitar formatos {nodes:{}} ou {pontos:{}}
    const nodes = mapJson.nodes || mapJson.pontos || {};
    this.nodes = {};
    for(const [id, data] of Object.entries(nodes)){
      this.nodes[id] = {
        id,
        title: data.title || id,
        panorama: data.panorama || data.imagem,
        // aceitar links como array de strings ou objetos com yaw/pitch
        links: (data.links||[]).map((l,i)=> typeof l === 'string' ? {targetId:l, yaw: (i*360/Math.max(1,data.links.length)) - 180, pitch: -8, text:`Ir para ${l}`} : l),
        state: data.state || data.estado || 'bloqueado'
      };
    }
  }
  getNode(id){ return this.nodes[id] || null; }
  listNodes(){ return Object.values(this.nodes); }
}

class ProgressModel {
  constructor(map){
    this.stateIndex = {};
    this.lastNodeId = map.initialNodeId;
  }
  static from(map, persisted){
    const p = new ProgressModel(map);
    for(const n of map.listNodes()) p.stateIndex[n.id] = n.state || 'bloqueado';
    if(persisted){
      if(persisted.stateIndex) for(const [k,v] of Object.entries(persisted.stateIndex)) if(p.stateIndex[k]!==undefined) p.stateIndex[k]=v;
      if(persisted.lastNodeId && map.getNode(persisted.lastNodeId)) p.lastNodeId = persisted.lastNodeId;
    }
    return p;
  }
  isAccessible(id){ const st=this.stateIndex[id]; return st==='liberado'||st==='visitado'; }
  markVisited(id){ this.stateIndex[id]='visitado'; }
  liberate(id){ if(this.stateIndex[id]==='bloqueado') this.stateIndex[id]='liberado'; }
  serialize(){ return { stateIndex: deepClone(this.stateIndex), lastNodeId: this.lastNodeId }; }
}

class Unlocker {
  static onNodeLoaded(map, progress, nodeId){
    progress.markVisited(nodeId);
    progress.lastNodeId = nodeId;
    const node = map.getNode(nodeId);
    if(!node) return;
    for(const link of (node.links||[])) if(map.getNode(link.targetId)) progress.liberate(link.targetId);
  }
}

class PannellumHierarchyAdapter {
  constructor(containerId){ this.cid=containerId; this.viewer=null; }
  load(node, hotspots){
    if(!this.viewer){
      this.viewer = pannellum.viewer(this.cid, { type:'equirectangular', panorama: node.panorama, autoLoad:true, showZoomCtrl:true, showFullscreenCtrl:true });
      this.viewer.on('load', ()=> this._render(hotspots));
    } else {
      this.viewer.setPanorama(node.panorama);
      this.viewer.on('load', ()=> this._render(hotspots));
    }
  }
  _render(hotspots){
    try{ this.viewer.removeAllHotSpots(); }catch{}
    hotspots.forEach(h=>{
      this.viewer.addHotSpot({ pitch:h.pitch, yaw:h.yaw, type:'info', text:h.text, clickHandlerFunc:h.onClick });
    });
  }
}

class Navigator360 {
  constructor(mapJson, adapter, opts={}){
    this.map = new MapModel(mapJson);
    const persisted = StorageUtil.load(StorageKeys.PROGRESS, null);
    this.progress = ProgressModel.from(this.map, persisted);
    this.adapter = adapter;
    this.onProgress = opts.onProgress || (()=>{});
  }
  start(){ const startId = this.progress.lastNodeId || this.map.initialNodeId; this.goTo(startId); }
  visibleHotspots(node){
    const hs=[]; for(const l of (node.links||[])) if(this.progress.isAccessible(l.targetId)) hs.push({ pitch:l.pitch??-8, yaw:l.yaw??0, text:l.text||`Ir para ${l.targetId}`, onClick:()=>this.goTo(l.targetId) }); return hs;
  }
  goTo(nodeId){
    const node=this.map.getNode(nodeId); if(!node) return;
    if(!this.progress.isAccessible(nodeId) && this.progress.stateIndex[nodeId]!=='bloqueado') return;
    Unlocker.onNodeLoaded(this.map, this.progress, nodeId);
    this.adapter.load(node, this.visibleHotspots(node));
    StorageUtil.save(StorageKeys.PROGRESS, this.progress.serialize());
    this.onProgress(deepClone(this.progress.serialize()));
  }
}

// Toggle entre modo usuário e admin
document.getElementById('modeToggle').addEventListener('change', function() {
    if (this.checked) {
        showAdminMode();
    } else {
        showUserMode();
    }
});

// Login usuário
document.getElementById('loginForm').addEventListener('submit', function(e) {
    e.preventDefault();
    
    const projectNameRaw = document.getElementById('projectName').value.trim();
    const projectName = slugify(projectNameRaw);
    const password = document.getElementById('password').value;
    const errorDiv = document.getElementById('errorMessage');
    
    if (projects[projectName] && projects[projectName].password === password) {
        errorDiv.classList.add('hidden');
        showViewer(projectName);
    } else {
        errorDiv.textContent = 'Nome do projeto ou senha incorretos!';
        errorDiv.classList.remove('hidden');
    }
});

// Login admin
document.getElementById('adminForm').addEventListener('submit', function(e) {
    e.preventDefault();
    
    const password = document.getElementById('adminPassword').value;
    const errorDiv = document.getElementById('errorMessage');
    
    if (password === ADMIN_PASSWORD) {
        errorDiv.classList.add('hidden');
        showAdminPanel();
    } else {
        errorDiv.textContent = 'Senha de admin incorreta!';
        errorDiv.classList.remove('hidden');
    }
});

// Preview da imagem
document.getElementById('imageUpload').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            showImagePreview(e.target.result);
        };
        reader.readAsDataURL(file);
    } else {
        hideImagePreview();
    }
});

// Controles de hotspot
document.getElementById('addHotspotBtn').addEventListener('click', function() {
    setAddHotspotMode(true);
});

document.getElementById('removeHotspotBtn').addEventListener('click', function() {
    hotspots = [];
    updateHotspotsList();
    if (previewViewer) {
        previewViewer.removeAllHotSpots();
    }
});



// Criar novo projeto
document.getElementById('createProjectForm').addEventListener('submit', function(e) {
    e.preventDefault();
    
    const nameRaw = document.getElementById('newProjectName').value.trim();
    const name = slugify(nameRaw);
    const password = document.getElementById('newProjectPassword').value;
    const title = document.getElementById('newProjectTitle').value.trim();
    const imageFile = document.getElementById('imageUpload').files[0];

    if (!name) {
        toast('Informe um nome de projeto.', 'warn');
        return;
    }
    if (!title) {
        toast('Informe um título.', 'warn');
        return;
    }
    if (!imageFile) {
        toast('Selecione uma imagem 360°.', 'warn');
        return;
    }
    if (projects[name]) {
        toast('Projeto já existe!', 'danger');
        return;
    }
    
    const reader = new FileReader();
    reader.onload = function(e) {
        projects[name] = {
            password: password,
            image: e.target.result,
            title: title,
            hotspots: [...hotspots],
            createdAt: new Date().toISOString()
        };
        saveProjects();
        
        toast('Projeto criado com sucesso!', 'ok');
        document.getElementById('createProjectForm').reset();
        hideImagePreview();
        showSection('projects');
        updateProjectsGrid();
    };
    reader.readAsDataURL(imageFile);
});

// Logout buttons
document.getElementById('logoutBtn').addEventListener('click', logout);
document.getElementById('adminLogoutBtn').addEventListener('click', logout);

function showViewer(projectName) {
    const project = projects[projectName];
    document.getElementById('loginContainer').classList.add('hidden');
    document.getElementById('viewerContainer').classList.remove('hidden');
    document.getElementById('projectTitle').textContent = project.title;

    // Se existir JSON hierárquico no localStorage (360:map), usar navegação progressiva.
    const mapJson = StorageUtil.load(StorageKeys.MAP, null);
    if (mapJson) {
        try {
            const adapter = new PannellumHierarchyAdapter('panorama');
            const nav = new Navigator360(mapJson, adapter, { onProgress: () => {} });
            nav.start();
            return; // não cair no fluxo antigo
        } catch (e) {
            console.error('Falha ao iniciar modo hierárquico, caindo no modo padrão.', e);
        }
    }

    // Fallback: comportamento antigo (sem hierarquia progressiva)
    const hotspotsWithImages = project.hotspots ? project.hotspots.filter(h => h.targetImage) : [];
    try {
        if (hotspotsWithImages.length > 0) {
            const scenes = createScenesConfig(project.image, project.hotspots || []);
            viewer = pannellum.viewer('panorama', {
                default: {
                    firstScene: 'main',
                    autoLoad: true,
                    autoRotate: -2,
                    compass: true,
                    showZoomCtrl: true,
                    showFullscreenCtrl: true
                },
                scenes: scenes
            });
            enhanceViewerTransitions(viewer, 'main');
        } else {
            viewer = pannellum.viewer('panorama', {
                type: 'equirectangular',
                panorama: project.image,
                autoLoad: true,
                autoRotate: -2,
                compass: true,
                showZoomCtrl: true,
                showFullscreenCtrl: true
            });
            enhanceViewerTransitions(viewer, 'main');
        }
    } catch (e) {
        console.error('Erro ao iniciar viewer:', e);
        toast('Não foi possível carregar o panorama.', 'danger');
    }
}

function showUserMode() {
    document.getElementById('userLogin').classList.remove('hidden');
    document.getElementById('adminLogin').classList.add('hidden');
    document.getElementById('errorMessage').classList.add('hidden');
}

function showAdminMode() {
    document.getElementById('userLogin').classList.add('hidden');
    document.getElementById('adminLogin').classList.remove('hidden');
    document.getElementById('errorMessage').classList.add('hidden');
}

function showAdminPanel() {
    document.getElementById('loginContainer').classList.add('hidden');
    document.getElementById('adminPanel').classList.remove('hidden');
    showSection('projects');
    updateProjectsGrid();
}

function showSection(section) {
    // Update navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
    });
    
    // Hide all sections
    document.getElementById('projectsSection').classList.add('hidden');
    document.getElementById('createSection').classList.add('hidden');
    
    if (section === 'projects') {
        document.getElementById('projectsSection').classList.remove('hidden');
        document.getElementById('pageTitle').textContent = 'Projetos';
        document.getElementById('pageSubtitle').textContent = 'Aqui você faz a gestão de seus projetos.';
        document.querySelectorAll('.nav-item')[0].classList.add('active');
    } else if (section === 'create') {
        document.getElementById('createSection').classList.remove('hidden');
        document.getElementById('pageTitle').textContent = 'Criar Projeto';
        document.getElementById('pageSubtitle').textContent = 'Configure um novo projeto 360°.';
        document.querySelectorAll('.nav-item')[1].classList.add('active');
    }
}

function updateProjectsGrid() {
    const grid = document.getElementById('projectsGrid');
    const emptyState = document.getElementById('emptyState');
    grid.innerHTML = '';
    
    const projectEntries = Object.entries(projects);
    
    if (projectEntries.length === 0) {
        emptyState.classList.remove('hidden');
        return;
    }
    
    emptyState.classList.add('hidden');
    
    projectEntries.forEach(([name, project]) => {
        const createdDate = new Date(project.createdAt).toLocaleDateString('pt-BR');
        const hotspotCount = project.hotspots ? project.hotspots.length : 0;
        
        const card = document.createElement('div');
        card.className = 'project-card';
        card.innerHTML = `
            <div class="project-thumbnail">🏠</div>
            <div class="project-info">
                <div class="project-name">${project.title}</div>
                <div class="project-meta">Tour Virtual 360° • ${createdDate} • ${hotspotCount} pontos</div>
                <div class="project-actions">
                    <button class="btn-sm btn-view" onclick="previewProject('${name}')">👁️ Ver</button>
                    <button class="btn-sm btn-delete" onclick="deleteProject('${name}')">🗑️ Excluir</button>
                </div>
            </div>
        `;
        grid.appendChild(card);
    });
}

function previewProject(name) {
    showViewer(name);
}

function deleteProject(name) {
    if (confirm(`Excluir projeto "${projects[name].title}"?`)) {
        delete projects[name];
        saveProjects();
        updateProjectsGrid();
        toast('Projeto excluído.', 'ok');
    }
}

function createScenesConfig(mainImage, hotspotsArray) {
    const scenes = { };

    function buildScene(sceneId, panorama, parentSceneId) {
        if (!scenes[sceneId]) {
            scenes[sceneId] = { type: 'equirectangular', panorama, hotSpots: [] };
        }
        if (parentSceneId) {
            scenes[sceneId].hotSpots.push({
                id: `back_${sceneId}`,
                pitch: -10,
                yaw: 0,
                type: 'scene',
                text: 'Voltar',
                sceneId: parentSceneId
            });
        }
        const thisHotspots = (hotspotsArray || []).filter(h => (h.parentId || null) === (sceneId === 'main' ? null : sceneId.replace('scene_', '')));
        thisHotspots.forEach(h => {
            const base = { id: h.id, pitch: h.pitch, yaw: h.yaw, text: h.text };
            if (h.targetImage) {
                const childSceneId = 'scene_' + h.id;
                scenes[sceneId].hotSpots.push({ ...base, type: 'scene', sceneId: childSceneId });
                buildScene(childSceneId, h.targetImage, sceneId);
            } else {
                scenes[sceneId].hotSpots.push({ ...base, type: 'info' });
            }
        });
    }

    buildScene('main', mainImage, null);
    return scenes;
}

function showImagePreview(imageSrc) {
    document.getElementById('imagePreview').classList.remove('hidden');
    currentParentId = null; // começamos na cena principal
    previewClickBound = false; // reanexar o listener no novo viewer
    previewCurrentImage = imageSrc;
    previewRootImage = imageSrc;

    if (previewViewer) {
        previewViewer.destroy();
    }

    setTimeout(() => {
        previewViewer = pannellum.viewer('previewPanorama', {
            type: 'equirectangular',
            panorama: previewCurrentImage,
            autoLoad: true,
            showZoomCtrl: false,
            showFullscreenCtrl: false
        });
        enhanceViewerTransitions(previewViewer, 'preview');

        previewViewer.on('load', function() {
            setTimeout(() => {
                const panoramaDiv = document.getElementById('previewPanorama');
                const container = panoramaDiv ? panoramaDiv.querySelector('.pnlm-container') : null;
                const targetEl = container || panoramaDiv;
                if (!targetEl) return;

                if (!previewClickBound) {
                    const onClickPreview = (event) => {
                        if (!addingHotspot) return;
                        event.preventDefault();
                        event.stopPropagation();
                        let coords = null;
                        try { coords = previewViewer.mouseEventToCoords(event); } catch (_) {}
                        const pitch = coords ? coords[0] : previewViewer.getPitch();
                        const yaw = coords ? coords[1] : previewViewer.getYaw();
                        const hotspotId = 'hotspot_' + Date.now();
                        const hotspot = {
                            id: hotspotId,
                            pitch: pitch,
                            yaw: yaw,
                            text: 'Ponto ' + (hotspots.length + 1),
                            targetImage: '',
                            parentId: currentParentId || null
                        };
                        hotspots.push(hotspot);
                        recreatePreviewViewer();
                        updateHotspotsList();
                        setAddHotspotMode(false);
                        toast('Ponto adicionado!', 'ok');
                    };
                    // usar captura para garantir que pegue antes do pannellum consumir
                    targetEl.addEventListener('click', onClickPreview, true);
                    previewClickBound = true;
                }
            }, 500);
        });
    }, 100);
}

function addHotspotToViewer(hotspot) {
    if (previewViewer) {
        previewViewer.addHotSpot({
            id: hotspot.id,
            pitch: hotspot.pitch,
            yaw: hotspot.yaw,
            type: hotspot.targetImage ? 'scene' : 'info',
            text: hotspot.text,
            sceneId: hotspot.targetImage ? 'scene_' + hotspot.id : undefined
        });
    }
}

function updateHotspotsList() {
    const list = document.getElementById('hotspotsList');
    list.innerHTML = '';

    const currentList = hotspots.filter(h => (h.parentId || null) === (currentParentId || null));

    // Botão voltar quando não estamos na cena principal
    if (currentParentId) {
        const backBtn = document.createElement('button');
        backBtn.textContent = '↩ Voltar';
        backBtn.className = 'hotspot-btn';
        backBtn.style.marginBottom = '8px';
        backBtn.onclick = () => {
            // localizar o hotspot pai do atual
            const parentHotspot = hotspots.find(h => h.id === currentParentId);
            const grandParentId = parentHotspot ? (parentHotspot.parentId || null) : null;
            currentParentId = grandParentId;
            // definir panorama conforme a cena atual
            if (grandParentId) {
                const gpHotspot = hotspots.find(h => h.id === grandParentId);
                if (gpHotspot && gpHotspot.targetImage) {
                    previewCurrentImage = gpHotspot.targetImage;
                    previewViewer.setPanorama(previewCurrentImage);
                }
            } else {
                // cena principal: garantir que a imagem raiz seja usada
                previewCurrentImage = previewRootImage;
                recreatePreviewViewer();
            }
            updateHotspotsList();
        };
        list.appendChild(backBtn);
    }

    if (currentList.length === 0) {
        const p = document.createElement('p');
        p.className = 'hotspot-empty muted';
        p.textContent = 'Nenhum ponto adicionado nesta cena';
        list.appendChild(p);
        return;
    }

    currentList.forEach((hotspot, index) => {
        const item = document.createElement('div');
        item.className = 'hotspot-item';
        
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = 'Nome do ponto';
        nameInput.value = hotspot.text;
        nameInput.className = 'hotspot-input';
        nameInput.addEventListener('change', () => updateHotspotText(hotspot.id, nameInput.value));
        
        const upBtn = document.createElement('button');
        upBtn.textContent = '↑';
        upBtn.className = 'hotspot-btn';
        upBtn.addEventListener('click', () => moveHotspot(hotspot.id, 0, 5));
        
        const leftBtn = document.createElement('button');
        leftBtn.textContent = '←';
        leftBtn.className = 'hotspot-btn';
        leftBtn.addEventListener('click', () => moveHotspot(hotspot.id, -5, 0));
        
        const centerBtn = document.createElement('button');
        centerBtn.textContent = 'Centro';
        centerBtn.className = 'hotspot-btn center';
        centerBtn.addEventListener('click', () => centerHotspot(hotspot.id));
        
        const rightBtn = document.createElement('button');
        rightBtn.textContent = '→';
        rightBtn.className = 'hotspot-btn';
        rightBtn.addEventListener('click', () => moveHotspot(hotspot.id, 5, 0));
        
        const downBtn = document.createElement('button');
        downBtn.textContent = '↓';
        downBtn.className = 'hotspot-btn';
        downBtn.addEventListener('click', () => moveHotspot(hotspot.id, 0, -5));
        
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.className = 'hotspot-file';
        fileInput.addEventListener('change', () => updateHotspotImage(hotspot.id, fileInput));
        
        const enterBtn = document.createElement('button');
        enterBtn.textContent = hotspot.targetImage ? '🔍 Entrar no Ponto' : 'Testar Posição';
        enterBtn.className = hotspot.targetImage ? 'hotspot-enter' : 'hotspot-action';
        enterBtn.addEventListener('click', () => {
            if (hotspot.targetImage && previewViewer) {
                currentParentId = hotspot.id; // entrar na subcena deste hotspot
                previewCurrentImage = hotspot.targetImage;
                previewViewer.setPanorama(previewCurrentImage);
                updateHotspotsList();
            } else if (previewViewer) {
                previewViewer.lookAt(hotspot.pitch, hotspot.yaw, 75, 1000);
            }
        });
        
        const removeBtn = document.createElement('button');
        removeBtn.textContent = 'Remover';
        removeBtn.className = 'hotspot-remove';
        removeBtn.addEventListener('click', () => removeHotspot(hotspot.id));
        
        item.innerHTML = `
            <div style="font-weight: 600; margin-bottom: 8px;">Ponto ${index + 1}</div>
            <div class="name-input"></div>
            <div class="hotspot-controls">
                <div class="title">Ajustar Posição:</div>
                <div class="hotspot-grid">
                    <div></div>
                    <div class="up-btn"></div>
                    <div></div>
                </div>
                <div class="hotspot-grid-2">
                    <div></div>
                    <div class="left-btn"></div>
                    <div class="center-btn"></div>
                    <div class="right-btn"></div>
                    <div></div>
                </div>
                <div class="hotspot-grid-3">
                    <div></div>
                    <div class="down-btn"></div>
                    <div></div>
                </div>
                <div style="font-size: 11px; color: #6b7280; margin-top: 6px; text-align: center;">Pitch: ${hotspot.pitch.toFixed(1)}° | Yaw: ${hotspot.yaw.toFixed(1)}°</div>
            </div>
            <div class="file-input"></div>
            <small style="color: #6b7280; display: block; margin: 4px 0;">Selecione a imagem 360° para este ponto</small>
            <div class="enter-btn"></div>
            <div class="remove-btn"></div>
        `;
        
        item.querySelector('.name-input').appendChild(nameInput);
        item.querySelector('.up-btn').appendChild(upBtn);
        item.querySelector('.left-btn').appendChild(leftBtn);
        item.querySelector('.center-btn').appendChild(centerBtn);
        item.querySelector('.right-btn').appendChild(rightBtn);
        item.querySelector('.down-btn').appendChild(downBtn);
        item.querySelector('.file-input').appendChild(fileInput);
        item.querySelector('.enter-btn').appendChild(enterBtn);
        item.querySelector('.remove-btn').appendChild(removeBtn);
        
        list.appendChild(item);
    });
}

function updateHotspotText(id, text) {
    const hotspot = hotspots.find(h => h.id === id);
    if (hotspot) {
        hotspot.text = text;
        previewViewer.removeHotSpot(id);
        addHotspotToViewer(hotspot);
    }
}

function updateHotspotImage(id, input) {
    const file = input.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            const hotspot = hotspots.find(h => h.id === id);
            if (hotspot) {
                hotspot.targetImage = e.target.result;
                // ao definir uma imagem, este hotspot vira uma subcena; recriar preview completo
                recreatePreviewViewer();
                toast('Cena conectada! Você pode entrar e adicionar pontos dentro dela.', 'ok');
            }
        };
        reader.readAsDataURL(file);
    }
}

function removeHotspot(id) {
    hotspots = hotspots.filter(h => h.id !== id);
    if (previewViewer) {
        previewViewer.removeHotSpot(id);
    }
    updateHotspotsList();
}

function hideImagePreview() {
    document.getElementById('imagePreview').classList.add('hidden');
    if (previewViewer) {
        previewViewer.destroy();
        previewViewer = null;
    }
    hotspots = [];
    addingHotspot = false;
}

function toggleFullscreen() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen();
    } else {
        document.exitFullscreen();
    }
}

function showHelpModal() {
    const modal = document.getElementById('helpModal');
    modal.classList.remove('hidden');
}

function closeHelpModal() {
    const modal = document.getElementById('helpModal');
    modal.classList.add('hidden');
}

function toggleNavigation() {
    const sidebar = document.getElementById('navSidebar');
    if (!sidebar) return;
    const isOpen = sidebar.classList.toggle('open');
    document.querySelectorAll('.nav-toggle, .nav-close').forEach(btn => {
        btn.setAttribute('aria-expanded', String(isOpen));
    });
}

function moveHotspot(id, deltaYaw, deltaPitch) {
    const hotspot = hotspots.find(h => h.id === id);
    if (hotspot && previewViewer) {
        hotspot.yaw = ((hotspot.yaw + deltaYaw) % 360 + 360) % 360;
        hotspot.pitch = Math.max(-90, Math.min(90, hotspot.pitch + deltaPitch));
        previewViewer.removeHotSpot(id);
        previewViewer.addHotSpot({
            id: hotspot.id,
            pitch: hotspot.pitch,
            yaw: hotspot.yaw,
            type: hotspot.targetImage ? 'scene' : 'info',
            text: hotspot.text,
            sceneId: hotspot.targetImage ? 'scene_' + hotspot.id : undefined
        });
        updateHotspotsList();
    }
}

function centerHotspot(id) {
    const hotspot = hotspots.find(h => h.id === id);
    if (hotspot && previewViewer) {
        // Centralizar na vista atual
        hotspot.pitch = previewViewer.getPitch();
        hotspot.yaw = previewViewer.getYaw();
        
        // Recriar viewer com navegação atualizada
        recreatePreviewViewer();
        
        // Atualizar lista
        updateHotspotsList();
    }
}

function recreatePreviewViewer() {
    if (!previewViewer) return;

    const currentImage = currentParentId ? previewCurrentImage : previewRootImage;
    previewClickBound = false; // garantir que o listener será reanexado
    previewViewer.destroy();

    setTimeout(() => {
        const scenes = createScenesConfig(currentImage, hotspots);

        previewViewer = pannellum.viewer('previewPanorama', {
            default: {
                firstScene: 'main',
                autoLoad: true
            },
            scenes: scenes
        });
        enhanceViewerTransitions(previewViewer, 'preview');
    }, 200);
}

// Tooltip/Hotspot enhancements
function hotspotTooltip(hotSpotDiv, args) {
    hotSpotDiv.classList.add('hotspot-dot', 'pulse');
    hotSpotDiv.setAttribute('title', args && args.text ? args.text : '');
    const ripple = document.createElement('div');
    ripple.className = 'ripple';
    hotSpotDiv.appendChild(ripple);
    hotSpotDiv.addEventListener('click', () => {
        hotSpotDiv.classList.remove('rippling');
        // force reflow
        void hotSpotDiv.offsetWidth;
        hotSpotDiv.classList.add('rippling');
        setTimeout(() => hotSpotDiv.classList.remove('rippling'), 650);
    });
}

function enhanceViewerTransitions(instance, kind) {
    const pano = document.getElementById(kind === 'preview' ? 'previewPanorama' : 'panorama');
    if (!pano) return;
    if (!pano.querySelector('.transition-fade')) {
        const overlay = document.createElement('div');
        overlay.className = 'transition-fade';
        pano.appendChild(overlay);
    }
    instance.on('scenechange', () => {
        pano.classList.add('fading');
    });
    instance.on('load', () => {
        setTimeout(() => pano.classList.remove('fading'), 100);
    });
}

// Utils
function slugify(str) {
    return (str || '')
        .toLowerCase()
        .normalize('NFD').replace(/\p{Diacritic}/gu, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function setAddHotspotMode(on) {
    const btn = document.getElementById('addHotspotBtn');
    addingHotspot = !!on;
    if (btn) {
        if (on) {
            btn.classList.remove('btn-secondary');
            btn.classList.add('btn-warning');
            btn.style.background = '#fbbf24';
            btn.textContent = 'Clique na imagem';
        } else {
            btn.classList.add('btn-secondary');
            btn.style.background = '';
            btn.textContent = 'Adicionar Ponto';
        }
    }
}

function toast(msg, type = 'ok') {
    const errorDiv = document.getElementById('errorMessage');
    if (!errorDiv) return alert(msg);
    errorDiv.textContent = msg;
    errorDiv.classList.remove('hidden');
    setTimeout(() => errorDiv.classList.add('hidden'), 2500);
}

function logout() {
    if (viewer) {
        viewer.destroy();
        viewer = null;
    }
    
    if (previewViewer) {
        previewViewer.destroy();
        previewViewer = null;
    }
    
    document.getElementById('viewerContainer').classList.add('hidden');
    document.getElementById('adminPanel').classList.add('hidden');
    document.getElementById('loginContainer').classList.remove('hidden');
    document.getElementById('loginForm').reset();
    document.getElementById('adminForm').reset();
    document.getElementById('errorMessage').classList.add('hidden');
    document.getElementById('modeToggle').checked = false;
    hideImagePreview();
    showUserMode();
}