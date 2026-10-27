
const API_URL = "/api/products";

// Get all products
export async function getProducts() {
  try {
    const response = await fetch(API_URL);

    if (!response.ok) {
      throw new Error("Failed to fetch products");
    }

    const data = await response.json();
    return data.products;
  } catch (error) {
    console.error("Product API Error:", error);
    throw error;
  }
}

// Get single product
export async function getProductById(id) {
  try {
    const response = await fetch(`${API_URL}/${id}`);

    if (!response.ok) {
      throw new Error("Failed to fetch product");
    }

    const data = await response.json();
    return data.product;
  } catch (error) {
    console.error("Product API Error:", error);
    throw error;
  }
}
