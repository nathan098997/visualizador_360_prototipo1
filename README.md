# Visualizador 360° com Sistema de Login

## Como usar:

### 1. Adicionar imagens 360°
- Coloque suas imagens panorâmicas na pasta `images/`
- Formatos suportados: JPG, PNG
- Recomendado: imagens equiretangulares (2:1 ratio)

### 2. Configurar projetos
No arquivo `script.js`, edite o objeto `projects`:

```javascript
const projects = {
    'nome-do-projeto': {
        password: 'senha-do-projeto',
        image: 'images/sua-imagem-360.jpg',
        title: 'Título do Projeto'
    }
};
```

### 3. Projetos de exemplo incluídos:
- **projeto-demo** / senha: 123456
- **casa-modelo** / senha: casa2024  
- **apartamento-luxo** / senha: luxo789

### 4. Para executar:
- Abra o arquivo `index.html` em um navegador
- Ou use um servidor local para melhor performance

### 5. Funcionalidades:
- Login por projeto/senha
- Visualização 360° interativa
- Controles de zoom e rotação
- Modo fullscreen
- Rotação automática
- Bússola de navegação

### 6. Adicionar novos projetos:
1. Adicione a imagem 360° na pasta `images/`
2. Configure no `script.js`
3. Forneça o nome do projeto e senha para o cliente